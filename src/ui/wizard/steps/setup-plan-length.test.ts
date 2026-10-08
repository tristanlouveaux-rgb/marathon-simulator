// @vitest-environment jsdom
/**
 * The triathlon, cycling and HYROX setup steps write the plan length the plan
 * is built on: the calendar weeks from this local Monday through the week
 * holding race day (racePlanCalendarWeeks, the layout running uses).
 *
 * Before: planDurationWeeks = calculateWeeksUntil(raceDate) = ceil(days from
 * today / 7). Onboarding on Sunday 11 Oct 2026 for a race on Sunday 15 Nov 2026
 * wrote 5 while the race sits in week 6 of a plan starting Monday 5 Oct.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

const h = vi.hoisted(() => {
  const store: { state: any } = { state: { onboarding: {} } };
  return {
    store,
    getState: vi.fn(() => store.state),
    nextStep: vi.fn(),
    updateOnboarding: vi.fn((u: any) => {
      store.state = { ...store.state, onboarding: { ...store.state.onboarding, ...u } };
    }),
  };
});

vi.mock('@/state/store', () => ({ getState: h.getState }));
vi.mock('../controller', () => ({ nextStep: h.nextStep, updateOnboarding: h.updateOnboarding }));
vi.mock('../renderer', () => ({ renderProgressIndicator: () => '', renderBackButton: () => '' }));
vi.mock('@/ui/page-flair', () => ({
  buildRingBackground: () => '', buildSunGlint: () => '', buildAtmosphereBase: () => '',
}));

import { renderTriathlonSetup } from './triathlon-setup';
import { renderCyclingSetup } from './cycling-setup';
import { renderHyroxSetup } from './hyrox-setup';

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

function mount(render: (c: HTMLElement, s: OnboardingState) => void, onboarding: Partial<OnboardingState>): void {
  h.store.state = { onboarding: { ...onboarding } };
  document.body.innerHTML = '<div id="app-root"></div>';
  render(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
}

const ob = () => h.store.state.onboarding as OnboardingState;

const STEPS: Array<[string, (c: HTMLElement, s: OnboardingState) => void, Partial<OnboardingState>, string]> = [
  ['triathlon', renderTriathlonSetup, { trainingMode: 'triathlon', triDistance: '70.3', selectedTriathlonId: null }, 'tri-continue'],
  ['cycling', renderCyclingSetup, { trainingMode: 'cycling', cyclingDistance: '160km' } as Partial<OnboardingState>, 'cyc-continue'],
  ['hyrox', renderHyroxSetup, { currentStep: 'hyrox-setup', trainingMode: 'hyrox' } as Partial<OnboardingState>, 'hx-continue'],
];

// [label, onboarding local time, race date, plan weeks]
const CASES: Array<[string, string, string, number]> = [
  ['Sunday onboarding, Sunday race', '2026-10-11T12:00:00', '2026-11-15', 6],
  ['Saturday onboarding, Saturday race', '2026-10-10T12:00:00', '2026-11-14', 6],
  ['Monday onboarding, Sunday race', '2026-10-05T12:00:00', '2026-11-15', 6],
];

describe('setup steps: plan length is the calendar weeks through race week', () => {
  beforeEach(() => {
    h.nextStep.mockClear();
    (Element.prototype as any).scrollIntoView = vi.fn();
    process.env.TZ = 'Europe/London';
  });
  afterEach(() => { vi.useRealTimers(); });

  for (const [mode, render, onboarding, ctaId] of STEPS) {
    for (const [label, now, race, weeks] of CASES) {
      it(`${mode}, ${label}: planDurationWeeks = ${weeks}`, () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(now));
        mount(render, { ...onboarding, customRaceDate: race });
        (document.getElementById(ctaId) as HTMLButtonElement).click();
        expect(h.nextStep).toHaveBeenCalledTimes(1);
        expect(ob().planDurationWeeks).toBe(weeks);
      });
    }
  }
});
