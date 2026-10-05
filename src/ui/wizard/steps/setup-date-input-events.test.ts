// @vitest-environment jsdom
/**
 * Race-date fields on the triathlon and cycling setup steps commit on 'input'
 * as well as 'change'.
 *
 * Desktop Safari and Firefox fire 'change' on a date field only on blur; the
 * iOS picker and Chrome fire both. With a 'change'-only listener the triathlon
 * Continue stayed disabled while a typed date sat in the field, and the cycling
 * step could advance without the date it showed (falling back to the default
 * plan length). Same requirement as the race-target and HYROX date fields
 * (2026-10-05 onboarding fix).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import { calculateWeeksUntil } from '@/data/marathons';

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

function mount(render: (c: HTMLElement, s: OnboardingState) => void, onboarding: Partial<OnboardingState>): void {
  h.store.state = { onboarding: { customRaceDate: null, ...onboarding } };
  document.body.innerHTML = '<div id="app-root"></div>';
  render(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
}

/** What desktop Safari / Firefox send while the field still has focus. */
function typeDateInputOnly(id: string, iso: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = iso;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const ob = () => h.store.state.onboarding as OnboardingState;

describe('setup steps: race date commits on input', () => {
  beforeEach(() => { h.nextStep.mockClear(); });

  it("triathlon: a manually typed date enables Continue on 'input' alone", () => {
    mount(renderTriathlonSetup, { trainingMode: 'triathlon', triDistance: '70.3', selectedTriathlonId: null });
    const select = document.getElementById('tri-race-select') as HTMLSelectElement;
    select.value = '__custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    typeDateInputOnly('tri-race-date', '2027-06-13');
    expect(ob().customRaceDate).toBe('2027-06-13');
    expect((document.getElementById('tri-continue') as HTMLButtonElement).disabled).toBe(false);
  });

  it("cycling: a date typed with 'input' alone is kept when Continue is tapped", () => {
    mount(renderCyclingSetup, { trainingMode: 'cycling', cyclingDistance: '160km' } as Partial<OnboardingState>);
    typeDateInputOnly('cyc-race-date', '2027-06-13');
    (document.getElementById('cyc-continue') as HTMLButtonElement).click();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(ob().customRaceDate).toBe('2027-06-13');
    expect(ob().planDurationWeeks).toBe(calculateWeeksUntil('2027-06-13'));
  });
});
