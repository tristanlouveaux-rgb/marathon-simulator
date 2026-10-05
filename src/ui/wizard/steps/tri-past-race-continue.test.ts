// @vitest-environment jsdom
/**
 * Tri past-race step: what happens when Continue can't save the race.
 *
 * Regression guard for "if you manually put in a time, you can't progress"
 * (2026-10-05). On manual entry no distance pill starts selected, and the only
 * feedback for a missing field was a 1.5 s change of a 1px card border from
 * 6% to 30% black, on a card two cards above the time. No text, no scroll.
 *
 * Contract asserted here:
 *   - a blocked Continue writes the reason next to the button and scrolls to
 *     the card that needs attention
 *   - the reason clears once the field is filled
 *   - the time boxes ask iOS for the digit pad
 *   - per-leg splits read the way they are typed (sprint run "24:50" is mm:ss,
 *     swim "0:32:00" is accepted) and an unreadable split is named, not dropped
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
  callEdgeFunction: vi.fn(),
}));

import { renderTriPastRace } from './tri-past-race';

const scrollSpy = vi.fn();

function mount(): void {
  h.store.state = { onboarding: { currentStep: 'tri-past-race', trainingMode: 'triathlon', triDistance: 'ironman', triPastRace: null } };
  document.body.innerHTML = '<div id="app-root"></div>';
  renderTriPastRace(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
  const toggle = document.getElementById('tpr-has-race') as HTMLInputElement;
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
}

function type(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur'));
}

function fillTimeAndMonth(h_: string, m: string, s = ''): void {
  type('tpr-date', '2026-06');
  type('tpr-h', h_);
  type('tpr-m', m);
  if (s) type('tpr-s', s);
}

const pick = (d: string) => (document.querySelector(`[data-dist="${d}"]`) as HTMLButtonElement).click();
const tapContinue = () => (document.getElementById('tpr-continue') as HTMLButtonElement).click();
const shown = (id: string): string => {
  const el = document.getElementById(id) as HTMLElement | null;
  if (!el || el.style.display === 'none') return '';
  return (el.textContent ?? '').trim();
};
const saved = () => (h.store.state.onboarding as OnboardingState).triPastRace;

describe('tri-past-race: a blocked Continue says why', () => {
  beforeEach(() => {
    h.nextStep.mockClear();
    scrollSpy.mockClear();
    (Element.prototype as any).scrollIntoView = scrollSpy;
  });

  it('typed time and month with no distance: names the distance and scrolls to its card', () => {
    mount();
    fillTimeAndMonth('5', '32', '10');
    tapContinue();

    expect(h.nextStep).not.toHaveBeenCalled();
    expect(shown('tpr-continue-hint')).toMatch(/race distance/i);
    expect(scrollSpy).toHaveBeenCalled();
    const target = scrollSpy.mock.contexts[0] as HTMLElement;
    expect(target.querySelector('[data-dist]')).not.toBeNull();
    // The card scrolled to carries the reason too (the button is off-screen by then on a phone).
    expect(target.querySelector('.tpr-card-reason')?.textContent).toMatch(/race distance/i);
  });

  it('picking the distance clears the reason and Continue saves the race', () => {
    mount();
    fillTimeAndMonth('5', '32');
    tapContinue();
    expect(shown('tpr-continue-hint')).not.toBe('');

    pick('70.3');
    expect(shown('tpr-continue-hint')).toBe('');
    expect(document.querySelector('.tpr-card-reason')).toBeNull();
    tapContinue();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(saved()).toMatchObject({ distance: '70.3', dateISO: '2026-06', totalSec: 5 * 3600 + 32 * 60 });
  });

  it('a missing month is named', () => {
    mount();
    pick('olympic');
    type('tpr-h', '2');
    type('tpr-m', '31');
    tapContinue();
    expect(h.nextStep).not.toHaveBeenCalled();
    expect(shown('tpr-continue-hint')).toMatch(/month/i);
  });

  it('a missing finish time is named', () => {
    mount();
    pick('olympic');
    type('tpr-date', '2026-06');
    tapContinue();
    expect(h.nextStep).not.toHaveBeenCalled();
    expect(shown('tpr-continue-hint')).toMatch(/finish time/i);
  });

  it('the hours, minutes and seconds boxes ask for the digit keypad', () => {
    mount();
    for (const id of ['tpr-h', 'tpr-m', 'tpr-s']) {
      expect((document.getElementById(id) as HTMLInputElement).getAttribute('inputmode')).toBe('numeric');
    }
  });
});

describe('tri-past-race: per-leg splits read the way they are typed', () => {
  beforeEach(() => {
    h.nextStep.mockClear();
    (Element.prototype as any).scrollIntoView = scrollSpy;
  });

  function withLegs(distance: string, total: [string, string, string], legs: [string, string, string]): void {
    mount();
    pick(distance);
    fillTimeAndMonth(...total);
    const toggle = document.getElementById('tpr-has-legs') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    type('tpr-swim', legs[0]);
    type('tpr-bike', legs[1]);
    type('tpr-run', legs[2]);
  }

  it('a sprint run typed "24:50" is 24 min 50 s, not 24 h 50 min', () => {
    withLegs('sprint', ['1', '25', '0'], ['13:10', '40:10', '24:50']);
    tapContinue();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(saved()?.perLeg).toEqual({ swim: 790, bike: 2410, run: 1490 });
  });

  it('a long-course bike typed "2:35" within the finish time reads as h:mm', () => {
    withLegs('70.3', ['5', '30', '0'], ['35:00', '2:35', '1:55:00']);
    tapContinue();
    expect(saved()?.perLeg).toEqual({ swim: 2100, bike: 2 * 3600 + 35 * 60, run: 3600 + 55 * 60 });
  });

  it('a swim typed as h:mm:ss "0:32:00" is accepted', () => {
    withLegs('olympic', ['2', '30', '0'], ['0:32:00', '1:10:00', '0:45:00']);
    tapContinue();
    expect(saved()?.perLeg).toEqual({ swim: 1920, bike: 4200, run: 2700 });
  });

  it('an unreadable split is named instead of silently dropping every split', () => {
    withLegs('olympic', ['2', '30', '0'], ['25:30', 'abc', '45:00']);
    expect(shown('tpr-legs-hint')).toMatch(/bike/i);
    tapContinue();
    expect(h.nextStep).not.toHaveBeenCalled();
    expect(shown('tpr-continue-hint')).toMatch(/bike/i);
  });
});
