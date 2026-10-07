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
 *   - a refused date (past, today, beyond 52 weeks) writes its reason inline
 *     and keeps Continue disabled with a hint that names the real rule
 *   - a date closer than a full build is NOT refused (Tristan 2026-10-05): it
 *     continues into a sharpening block with an inline plan note
 *   - state never holds a date the field no longer shows
 *   - 'input' alone (iOS picker / Firefox typing) updates the gate
 *   - accepting a date does not rebuild the input (iOS wheel picker survives)
 *   - the picker's min / max match the handler's own check
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import { trainingWeeksForRace } from './race-target-plan-note';
import { setState } from '@/state/store';
import type { SimulatorState } from '@/types';

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

  it('a marathon date under the 8-week build continues into a sharpening block with an inline note', async () => {
    const input = mount('marathon');
    const date = isoInDays(35); // Monday 9 November: 5 training weeks plus a closing week
    setDate(input, date);
    await flush();

    expect(visibleText('rt-date-error')).toBe('');
    expect(cta().disabled).toBe(false);
    expect(h.store.onboarding.customRaceDate).toBe(date);
    expect(h.store.onboarding.planDurationWeeks).toBe(5);
    expect(visibleText('rt-weeks-note')).toBe('5-week plan, short of the 8-week marathon build. 3 weeks of race-specific training from current fitness, then a 2-week taper.');
  });

  it('a half marathon 10 days out continues into a 2-week block', async () => {
    const input = mount('half');
    setDate(input, isoInDays(10));
    await flush();
    expect(visibleText('rt-date-error')).toBe('');
    expect(cta().disabled).toBe(false);
    expect(visibleText('rt-weeks-note')).toMatch(/^2-week plan, short of the 4-week half marathon build/);
  });

  it('a date today or in the past is refused with a visible reason', async () => {
    const input = mount('marathon');
    setDate(input, isoInDays(0));
    await flush();
    expect(visibleText('rt-date-error')).toBe('This date is today.');
    expect(cta().disabled).toBe(true);
    expect(visibleText('rt-continue-hint')).toMatch(/from tomorrow/);
    setDate(input, isoInDays(-3));
    await flush();
    expect(visibleText('rt-date-error')).toBe('That date has passed.');
    expect(h.store.onboarding.customRaceDate).toBe('');
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
    setDate(input, isoInDays(-1));
    await flush();
    const valid = isoInDays(120);
    setDate(input, valid);
    await flush();

    expect(visibleText('rt-date-error')).toBe('');
    expect(cta().disabled).toBe(false);
    expect(visibleText('rt-continue-hint')).toBe('');
    expect(h.store.onboarding.customRaceDate).toBe(valid);
    expect(h.store.onboarding.planDurationWeeks).toBe(trainingWeeksForRace(valid));
    expect(visibleText('rt-weeks-note')).toBe(`${trainingWeeksForRace(valid)} weeks of training`);
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

    setDate(input, isoInDays(0));
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

  it("the picker's min and max match the handler's check", async () => {
    const input = mount('marathon');
    // min is tomorrow (a sharpening block from 1 day out); max the last date
    // whose plan stays within 52 training weeks.
    expect(input.min).toBe(isoInDays(1));
    expect(trainingWeeksForRace(input.max)).toBeLessThanOrEqual(52);
    const dayAfterMax = new Date(input.max + 'T12:00:00');
    dayAfterMax.setDate(dayAfterMax.getDate() + 1);
    const next = `${dayAfterMax.getFullYear()}-${String(dayAfterMax.getMonth() + 1).padStart(2, '0')}-${String(dayAfterMax.getDate()).padStart(2, '0')}`;
    expect(trainingWeeksForRace(next)).toBeGreaterThan(52);

    setDate(input, input.max);
    await flush();
    expect(cta().disabled).toBe(false);
    setDate(input, input.min);
    await flush();
    expect(cta().disabled).toBe(false);
  });
});

describe('race-target: a marathon block that cannot build marathon endurance (owner decision 2026-10-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 0));
    h.updateOnboarding.mockClear();
    // Longest run of the last 30 days: 8 km.
    setState({
      v: 45, pac: { e: 330 }, athleteArchetype: { archetype: 'consistent-runner' },
      onboardingRunHistory: [{ startTime: new Date(2026, 9, 1, 8).toISOString(), distKm: 8, durSec: 2700, activityType: 'RUNNING' }],
    } as unknown as SimulatorState);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('says so plainly, calls the forecast optimistic, and offers a half on the same date', async () => {
    const input = mount('marathon');
    const date = isoInDays(41); // Sunday 15 November: 6 training weeks
    setDate(input, date);
    await flush();
    expect(cta().disabled).toBe(false);
    const note = document.getElementById('rt-block-note')!.textContent ?? '';
    expect(note).toMatch(/6 weeks cannot build marathon endurance\./);
    expect(note).toMatch(/the forecast finish time is optimistic/);
    const half = document.querySelector<HTMLButtonElement>('[data-switch="half"]')!;
    expect(half.textContent).toBe('Half marathon on the same date');
    half.click();
    await flush();
    expect(h.store.onboarding.raceDistance).toBe('half');
    expect(h.store.onboarding.customRaceDate).toBe(date);
    expect(h.store.onboarding.planDurationWeeks).toBe(6);
  });
});
