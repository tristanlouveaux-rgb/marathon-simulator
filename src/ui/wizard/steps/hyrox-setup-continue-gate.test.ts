// @vitest-environment jsdom
/**
 * HYROX setup: Continue gate after a typed previous time.
 *
 * Regression guard for "if you manually put in a time, you can't progress"
 * (2026-10-05). A typed previous time silently armed a second requirement
 * (which format that time was set in). The only reasons on the page were a
 * hover tooltip (never shown on touch) and an amber line four cards above the
 * button, and the native `disabled` swallowed every tap with no feedback.
 *
 * Contract asserted here:
 *   - the blocking reason is written next to Continue, live
 *   - taps on a gated Continue still arrive and scroll to the missing field
 *   - the amber prompt updates once a format is picked
 *   - "1:12" is not stored as a 72-second finish; a visible message asks for h:mm:ss
 *   - a field that stops parsing clears the stored time (no stale value)
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

import { renderHyroxSetup } from './hyrox-setup';

const scrollSpy = vi.fn();

function mount(onboarding: Partial<OnboardingState> = {}): void {
  h.store.state = {
    onboarding: { currentStep: 'hyrox-setup', trainingMode: 'hyrox', customRaceDate: null, ...onboarding },
  };
  document.body.innerHTML = '<div id="app-root"></div>';
  renderHyroxSetup(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
}

const ob = () => h.store.state.onboarding as OnboardingState;
const cta = () => document.getElementById('hx-continue') as HTMLButtonElement;
const timeInput = () => document.getElementById('hx-prev-time') as HTMLInputElement;
const shown = (id: string): string => {
  const el = document.getElementById(id) as HTMLElement | null;
  if (!el || el.style.display === 'none') return '';
  return (el.textContent ?? '').trim();
};

/** Type one key at a time (input per keystroke), then commit with change + blur. */
function typeTime(value: string): void {
  const input = timeInput();
  input.focus();
  if (input.value !== '') {
    // Select-all + delete fires one input event with an empty value.
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  for (const ch of value) {
    input.value += ch;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur'));
}

function pickCustomDate(iso: string): void {
  const select = document.getElementById('hx-race-event') as HTMLSelectElement;
  select.value = 'custom';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const date = document.getElementById('hx-race-date') as HTMLInputElement;
  date.value = iso;
  date.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('hyrox-setup: Continue explains the previous-time format gate', () => {
  beforeEach(() => {
    h.nextStep.mockClear();
    scrollSpy.mockClear();
    (Element.prototype as any).scrollIntoView = scrollSpy;
  });

  it('a typed time with no format shows the reason next to Continue, and a tap scrolls to the format pills', () => {
    mount({ customRaceDate: '2027-03-14' });
    typeTime('1:12:30');

    expect(ob().previousHyroxTimeSec).toBe(4350);
    expect(shown('hx-continue-hint')).toMatch(/format your previous time/i);
    // Taps must still arrive (native disabled swallows them on iOS).
    expect(cta().disabled).toBe(false);
    expect(cta().getAttribute('aria-disabled')).toBe('true');

    cta().click();
    expect(h.nextStep).not.toHaveBeenCalled();
    expect(scrollSpy).toHaveBeenCalled();
    const scrolled = scrollSpy.mock.contexts[0] as HTMLElement;
    expect(scrolled.id).toBe('hx-prev-time-format-row');
  });

  it('picking the format clears the reason, updates the amber prompt, and Continue advances', () => {
    mount({ customRaceDate: '2027-03-14' });
    typeTime('1:12:30');
    const prompt = document.getElementById('hx-prev-format-prompt') as HTMLElement;
    expect(prompt.textContent).toMatch(/Pick the format/);

    (document.querySelector('[data-prev-format="open_doubles"]') as HTMLButtonElement).click();
    expect(prompt.textContent).toMatch(/Which format was that time in/);
    expect(shown('hx-continue-hint')).toBe('');
    expect(cta().getAttribute('aria-disabled')).toBe('false');

    cta().click();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
  });

  it('a missing race date is named next to Continue and a tap scrolls to the race picker', () => {
    mount();
    expect(shown('hx-continue-hint')).toMatch(/race/i);
    cta().click();
    expect(h.nextStep).not.toHaveBeenCalled();
    expect((scrollSpy.mock.contexts[0] as HTMLElement).id).toBe('hx-race-event');
  });

  it("a race date typed into the manual field enables Continue on 'input' alone", () => {
    mount();
    pickCustomDate('2027-03-14');
    expect(ob().customRaceDate).toBe('2027-03-14');
    expect(shown('hx-continue-hint')).toBe('');
    cta().click();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['1:12:30', 4350],
    ['01:12:30', 4350],
    [' 1:12:30 ', 4350],
    ['72:30', 4350],
    ['58:05', 3485],
  ])('accepts %j as %i seconds', (typed, sec) => {
    mount({ customRaceDate: '2027-03-14' });
    typeTime(typed);
    expect(ob().previousHyroxTimeSec).toBe(sec);
    expect(shown('hx-prev-time-error')).toBe('');
  });

  it('"1:12" is not stored as a 72-second finish and the field explains h:mm:ss', () => {
    mount({ customRaceDate: '2027-03-14' });
    typeTime('1:12');
    expect(ob().previousHyroxTimeSec).toBeUndefined();
    expect(shown('hx-prev-time-error')).toMatch(/h:mm:ss/);
    // Continue names the problem instead of silently dropping the time.
    expect(shown('hx-continue-hint')).toMatch(/previous time/i);
    cta().click();
    expect(h.nextStep).not.toHaveBeenCalled();
  });

  it('unreadable text gets a visible message instead of being ignored', () => {
    mount({ customRaceDate: '2027-03-14' });
    typeTime('1h12m');
    expect(ob().previousHyroxTimeSec).toBeUndefined();
    expect(shown('hx-prev-time-error')).toMatch(/h:mm:ss/);
  });

  it('backspacing a valid time to "1:" clears the stored time instead of keeping 60 s', () => {
    mount({ customRaceDate: '2027-03-14' });
    typeTime('1:12:30');
    const input = timeInput();
    for (const v of ['1:12:3', '1:12:', '1:12', '1:1', '1:']) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(ob().previousHyroxTimeSec).toBeUndefined();
    // With no stored time the format requirement is not armed.
    expect(shown('hx-continue-hint')).not.toMatch(/format/i);
  });

  it('clearing the field removes the time and Continue advances without a format', () => {
    mount({ customRaceDate: '2027-03-14' });
    typeTime('1:12:30');
    typeTime('');
    expect(ob().previousHyroxTimeSec).toBeUndefined();
    cta().click();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
  });
});
