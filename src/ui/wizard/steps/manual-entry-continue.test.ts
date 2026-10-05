// @vitest-environment jsdom
/**
 * Manual-entry step: tapping Continue straight from a PB field.
 *
 * Regression guard for "if you manually put in a time, you can't progress"
 * (2026-10-05). With a PB field focused, the tap's mousedown blurred it; the
 * blur handler committed the PB and inserted the experience-consistency notice
 * ABOVE Continue (about 125px). The button moved down mid-tap, mouseup / click
 * were hit-tested at the old point and missed, and nextStep never ran.
 * Reproduced in real Chrome (iPhone 13 touch emulation and desktop mouse).
 * jsdom has no layout, so this guards the mechanism: mousedown on Continue
 * must not move focus, so no blur (and no layout shift) happens before click.
 *
 * Also asserted: invalid PB text is flagged on Continue instead of silently
 * dropped, and "0:00" is not stored as a PB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

const h = vi.hoisted(() => {
  const store: { state: any } = { state: { onboarding: {} } };
  return {
    store,
    getState: vi.fn(() => store.state),
    getMutableState: vi.fn(() => store.state),
    saveState: vi.fn(),
    nextStep: vi.fn(),
    getOnboardingState: vi.fn(() => store.state.onboarding),
    updateOnboarding: vi.fn((u: any) => {
      store.state = { ...store.state, onboarding: { ...store.state.onboarding, ...u } };
    }),
  };
});

vi.mock('@/state/store', () => ({ getState: h.getState, getMutableState: h.getMutableState }));
vi.mock('@/state/persistence', () => ({ saveState: h.saveState }));
vi.mock('../controller', () => ({
  nextStep: h.nextStep,
  updateOnboarding: h.updateOnboarding,
  getOnboardingState: h.getOnboardingState,
}));
vi.mock('../renderer', () => ({ renderProgressIndicator: () => '', renderBackButton: () => '' }));
vi.mock('@/ui/page-flair', () => ({
  buildRingBackground: () => '', buildSunGlint: () => '', buildAtmosphereBase: () => '',
}));

import { renderManualEntry } from './manual-entry';

const scrollSpy = vi.fn();

function mount(): void {
  h.store.state = {
    unitPref: 'km',
    onboarding: { currentStep: 'manual-entry', skippedStrava: true, experienceLevel: 'intermediate', pbs: {}, completedSteps: [] },
  };
  document.body.innerHTML = '<div id="app-root"></div>';
  renderManualEntry(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
}

function typeInto(id: string, text: string): HTMLInputElement {
  const input = document.getElementById(id) as HTMLInputElement;
  input.focus();
  for (const ch of text) {
    input.value += ch;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return input;
}

/** A real tap: mousedown (whose default action moves focus), then click. */
function tap(el: HTMLElement): MouseEvent {
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  el.dispatchEvent(down);
  if (!down.defaultPrevented) el.focus(); // what the browser does when mousedown isn't cancelled
  el.click();
  return down;
}

const shown = (id: string): string => {
  const el = document.getElementById(id) as HTMLElement | null;
  if (!el || el.style.display === 'none') return '';
  return (el.textContent ?? '').trim();
};
const ob = () => h.store.state.onboarding as OnboardingState;

describe('manual-entry: Continue straight from a focused PB field', () => {
  beforeEach(() => {
    h.nextStep.mockClear();
    scrollSpy.mockClear();
    (Element.prototype as any).scrollIntoView = scrollSpy;
  });

  it('mousedown on Continue keeps focus in the field, so the consistency notice is not inserted above the button mid-tap', () => {
    mount();
    const pb = typeInto('pb-5k', '18:30'); // fast enough to contradict "intermediate"
    const btn = document.getElementById('manual-continue') as HTMLButtonElement;

    let noticeBeforeClick = false;
    btn.addEventListener('click', () => { noticeBeforeClick = !!document.getElementById('exp-consistency-notice'); }, { capture: true });

    const down = tap(btn);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pb);
    // Nothing moved the button between press and click.
    expect(noticeBeforeClick).toBe(false);
    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(ob().pbs.k5).toBe(18 * 60 + 30);
  });

  it('a blur toward Continue does not refresh the notice above it', () => {
    mount();
    const pb = typeInto('pb-5k', '18:30');
    const btn = document.getElementById('manual-continue') as HTMLButtonElement;
    pb.dispatchEvent(new FocusEvent('blur', { relatedTarget: btn }));
    expect(document.getElementById('exp-consistency-notice')).toBeNull();
    // A blur toward anything else still shows it.
    pb.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
    expect(document.getElementById('exp-consistency-notice')).not.toBeNull();
  });

  it('invalid PB text is flagged on Continue instead of silently dropped', () => {
    mount();
    const pb = typeInto('pb-5k', '18.30');
    tap(document.getElementById('manual-continue')!);

    expect(h.nextStep).not.toHaveBeenCalled();
    expect(shown('pb-5k-err')).toMatch(/mm:ss/);
    expect(shown('manual-continue-hint')).not.toBe('');
    expect(scrollSpy.mock.contexts[0]).toBe(pb);

    // Fixing the field clears the hint and Continue advances.
    pb.value = '18:30';
    pb.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shown('manual-continue-hint')).toBe('');
    tap(document.getElementById('manual-continue')!);
    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(ob().pbs.k5).toBe(1110);
  });

  it('"0:00" is not stored as a 0-second PB', () => {
    mount();
    typeInto('pb-10k', '0:00');
    tap(document.getElementById('manual-continue')!);
    expect(h.nextStep).not.toHaveBeenCalled();
    expect(ob().pbs.k10).toBeUndefined();
  });

  it('empty PB fields still advance (every field is optional)', () => {
    mount();
    tap(document.getElementById('manual-continue')!);
    expect(h.nextStep).toHaveBeenCalledTimes(1);
  });
});
