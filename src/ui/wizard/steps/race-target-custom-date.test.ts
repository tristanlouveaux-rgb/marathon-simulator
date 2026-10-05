// @vitest-environment jsdom
/**
 * Race-target "Other / enter date manually" date field.
 *
 * Regression guard for "if you manually put in a time, you can't progress onto
 * the next page when inputting a race" (2026-10-05). A date under the distance
 * floor was refused by setCustomValidity + reportValidity alone: no state
 * change, no text on the page, and a Continue hint telling the user to set a
 * date they had just set. The native bubble fades on desktop and may never
 * show in WKWebView, so the refusal read as a dead button.
 *
 * Contract asserted here:
 *   - a refused date writes its reason inline and keeps Continue disabled with
 *     a hint that names the real rule
 *   - state never holds a date the field no longer shows
 *   - 'input' alone (iOS picker / Firefox typing) updates the gate
 *   - accepting a date does not rebuild the input (iOS wheel picker survives)
 *   - the picker's min / max match the handler's own week check
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import { calculateWeeksUntil } from '@/data/marathons';

const h = vi.hoisted(() => {
  const store: { onboarding: any } = { onboarding: {} };
  return {
    store,
    nextStep: vi.fn(),
    getOnboardingState: vi.fn(() => store.onboarding),
    updateOnboarding: vi.fn((u: any) => { store.onboarding = { ...store.onboarding, ...u }; }),
  };
});

vi.mock('../controller', () => ({
  nextStep: h.nextStep,
  updateOnboarding: h.updateOnboarding,
  getOnboardingState: h.getOnboardingState,
}));
vi.mock('../renderer', () => ({ renderProgressIndicator: () => '', renderBackButton: () => '' }));
vi.mock('@/ui/page-flair', () => ({ buildSunGlint: () => '', buildAtmosphereBase: () => '' }));

import { renderRaceTarget } from './race-target';

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };

/** Local YYYY-MM-DD `days` from today (what a date picker writes). */
function isoInDays(days: number): string {
  const d = new Date();
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function mount(distance: 'marathon' | 'half' = 'marathon'): HTMLInputElement {
  h.store.onboarding = {
    currentStep: 'race-target',
    trainingMode: 'running',
    trainingForEvent: true,
    raceDistance: distance,
    selectedRace: null,
    customRaceDate: '',
    planDurationWeeks: 16,
  } as Partial<OnboardingState>;
  document.body.innerHTML = '<div id="app-root"></div>';
  renderRaceTarget(document.getElementById('app-root')!, h.store.onboarding as OnboardingState);
  return document.getElementById('rt-custom-date') as HTMLInputElement;
}

function setDate(input: HTMLInputElement, value: string, events: Array<'input' | 'change'> = ['input', 'change']): void {
  input.value = value;
  for (const ev of events) input.dispatchEvent(new Event(ev, { bubbles: true }));
}

const cta = () => document.getElementById('rt-continue') as HTMLButtonElement;
const visibleText = (id: string): string => {
  const el = document.getElementById(id) as HTMLElement | null;
  if (!el || el.style.display === 'none') return '';
  return (el.textContent ?? '').trim();
};

describe('race-target custom date: Continue explains itself', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 0));
    h.nextStep.mockClear();
    h.updateOnboarding.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a marathon date under the 8-week floor shows the reason inline and keeps Continue disabled', async () => {
    const input = mount('marathon');
    setDate(input, isoInDays(35));
    await flush();

    expect(visibleText('rt-date-error')).toMatch(/at least 8 weeks/);
    expect(cta().disabled).toBe(true);
    // The hint under Continue names the real rule, not "set your own date".
    expect(visibleText('rt-continue-hint')).toMatch(/8 weeks/);
    expect(visibleText('rt-continue-hint')).not.toMatch(/set your own date/i);
    expect(h.store.onboarding.customRaceDate).toBe('');
  });

  it('a half marathon date under the 4-week floor is refused with a visible reason', async () => {
    const input = mount('half');
    setDate(input, isoInDays(10));
    await flush();
    expect(visibleText('rt-date-error')).toMatch(/at least 4 weeks/);
    expect(cta().disabled).toBe(true);
  });

  it('a date past the 52-week horizon is refused with a visible reason', async () => {
    const input = mount('marathon');
    setDate(input, isoInDays(400));
    await flush();
    expect(visibleText('rt-date-error')).toMatch(/52 weeks/);
    expect(cta().disabled).toBe(true);
    expect(h.store.onboarding.customRaceDate).toBe('');
  });

  it('a valid date after a refused one clears the error, enables Continue, and keeps the same input node', async () => {
    const input = mount('marathon');
    setDate(input, isoInDays(35));
    await flush();
    const valid = isoInDays(120);
    setDate(input, valid);
    await flush();

    expect(visibleText('rt-date-error')).toBe('');
    expect(cta().disabled).toBe(false);
    expect(visibleText('rt-continue-hint')).toBe('');
    expect(h.store.onboarding.customRaceDate).toBe(valid);
    expect(h.store.onboarding.planDurationWeeks).toBe(calculateWeeksUntil(valid));
    expect(visibleText('rt-weeks-note')).toBe(`${calculateWeeksUntil(valid)} weeks of training`);
    // No re-render: rebuilding the input tears down the iOS wheel picker mid-spin.
    expect(document.getElementById('rt-custom-date')).toBe(input);

    cta().click();
    await flush();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
  });

  it("'input' alone (iOS picker, Firefox typing) commits the date and enables Continue", async () => {
    const input = mount('marathon');
    const valid = isoInDays(100);
    setDate(input, valid, ['input']);
    await flush();
    expect(h.store.onboarding.customRaceDate).toBe(valid);
    expect(cta().disabled).toBe(false);
  });

  it('replacing a valid date with a refused one drops it from state and disables Continue', async () => {
    const input = mount('marathon');
    setDate(input, isoInDays(120));
    await flush();
    expect(cta().disabled).toBe(false);

    setDate(input, isoInDays(20));
    await flush();
    expect(h.store.onboarding.customRaceDate).toBe('');
    expect(cta().disabled).toBe(true);
    cta().click();
    await flush();
    expect(h.nextStep).not.toHaveBeenCalled();
  });

  it('clearing the field drops the old date from state', async () => {
    const input = mount('marathon');
    setDate(input, isoInDays(120));
    await flush();
    setDate(input, '');
    await flush();
    expect(h.store.onboarding.customRaceDate).toBe('');
    expect(cta().disabled).toBe(true);
    expect(visibleText('rt-date-error')).toBe('');
    expect(visibleText('rt-continue-hint')).not.toBe('');
  });

  it("the picker's min and max match the handler's week check", async () => {
    const input = mount('marathon');
    expect(input.min).not.toBe('');
    expect(input.max).not.toBe('');
    // min is the first accepted day, max the last.
    expect(calculateWeeksUntil(input.min)).toBeGreaterThanOrEqual(8);
    const dayBeforeMin = new Date(input.min + 'T12:00:00');
    dayBeforeMin.setDate(dayBeforeMin.getDate() - 1);
    const prev = `${dayBeforeMin.getFullYear()}-${String(dayBeforeMin.getMonth() + 1).padStart(2, '0')}-${String(dayBeforeMin.getDate()).padStart(2, '0')}`;
    expect(calculateWeeksUntil(prev)).toBeLessThan(8);
    expect(calculateWeeksUntil(input.max)).toBeLessThanOrEqual(52);

    setDate(input, input.max);
    await flush();
    expect(cta().disabled).toBe(false);
    setDate(input, input.min);
    await flush();
    expect(cta().disabled).toBe(false);
  });
});
