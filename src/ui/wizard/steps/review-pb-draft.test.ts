// @vitest-environment jsdom
/**
 * Review step: a PB typed into the inline editor counts without tapping Save.
 *
 * Regression guard (2026-10-05). The typed time only reached state through the
 * small "Save" link. Return, tapping away, and "Build my plan" all ignored it:
 * Build stayed dimmed with "Add at least one personal best to continue" under
 * the PB the user had just typed, and a bad format got a red border with no
 * words.
 *
 * Contract asserted here:
 *   - Return in the editor commits it
 *   - a valid typed time lights up Build, and Build saves it before advancing
 *   - a bad format says what format to use
 *   - opening an editor and leaving it unchanged does not rewrite the PB
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
      store.state.onboarding = { ...store.state.onboarding, ...u };
    }),
  };
});

vi.mock('@/state/store', () => ({ getState: h.getState, getMutableState: h.getMutableState, updateState: vi.fn() }));
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
vi.mock('@/data/sources', () => ({ hasPhysiologySource: () => false }));
vi.mock('@/data/supabaseClient', () => ({
  SUPABASE_URL: 'http://localhost', SUPABASE_ANON_KEY: 'test',
  getAccessToken: async () => '', getUserId: async () => '',
  isGarminConnected: async () => false, triggerGarminBackfill: async () => {},
}));
vi.mock('@/data/stravaSync', () => ({ backfillStravaHistory: vi.fn(async () => {}) }));
vi.mock('@/data/physiologySync', () => ({ syncPhysiologySnapshot: vi.fn(async () => {}) }));
vi.mock('@/data/tri-activity-loader', () => ({ loadActivitiesFromDB: vi.fn(async () => []) }));
vi.mock('@/calculations/tri-benchmarks-from-history', () => ({ deriveTriBenchmarksFromHistory: vi.fn(() => ({})) }));
vi.mock('@/data/ltSync', () => ({ recomputeLT: vi.fn(() => 'noop'), diagnoseLTForState: vi.fn(() => []) }));
vi.mock('@/app/runtime', () => ({ awaitStartupSyncs: vi.fn(async () => {}) }));
vi.mock('@/calculations/blended-fitness', () => ({ refreshBlendedFitness: vi.fn() }));
vi.mock('@/ui/strava-brand', () => ({ poweredByStrava: () => '' }));

async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 5));
}

let renderReview: (c: HTMLElement, s: OnboardingState) => void;

async function mount(onboarding: Partial<OnboardingState> = {}): Promise<void> {
  h.store.state = {
    unitPref: 'km',
    detectedWeeklyKm: 30,
    pbs: {},
    onboarding: {
      currentStep: 'review',
      trainingMode: 'running',
      skippedStrava: true,
      experienceLevel: 'intermediate',
      pbs: {},
      completedSteps: [],
      ...onboarding,
    },
  };
  document.body.innerHTML = '<div id="app-root"></div>';
  renderReview(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
  await waitFor(() => !!document.getElementById('r-continue'));
}

async function openPbEditor(row: 'pb-k5' | 'pb-k10' | 'pb-h' | 'pb-m'): Promise<HTMLInputElement> {
  (document.querySelector(`[data-row="${row}"]`) as HTMLElement).click();
  await waitFor(() => !!document.getElementById('r-pb-input'));
  return document.getElementById('r-pb-input') as HTMLInputElement;
}

function typeKeys(input: HTMLInputElement, text: string): void {
  input.focus();
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  for (const ch of text) {
    input.value += ch;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

const cta = () => document.getElementById('r-continue') as HTMLButtonElement;
const ob = () => h.store.state.onboarding as OnboardingState;

describe('review: a typed PB counts without tapping Save', () => {
  beforeEach(async () => {
    vi.resetModules();
    h.nextStep.mockClear();
    (Element.prototype as any).scrollIntoView = vi.fn();
    ({ renderReview } = await import('./review'));
  });

  it('Return in the PB editor commits the time', async () => {
    await mount();
    expect(cta().disabled).toBe(true);
    const input = await openPbEditor('pb-k5');
    typeKeys(input, '22:30');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitFor(() => !document.getElementById('r-pb-input'));

    expect(ob().pbs.k5).toBe(1350);
    expect(document.getElementById('r-pb-input')).toBeNull();
    expect(cta().disabled).toBe(false);
  }, 20000);

  it('a valid typed time enables Build, and Build saves it before advancing', async () => {
    await mount();
    const input = await openPbEditor('pb-k5');
    typeKeys(input, '22:30');

    expect(cta().disabled).toBe(false);
    cta().click();
    expect(ob().pbs.k5).toBe(1350);
    expect(h.nextStep).toHaveBeenCalledTimes(1);
  }, 20000);

  it('a bad format says which format to use', async () => {
    await mount();
    const input = await openPbEditor('pb-k5');
    typeKeys(input, '22.30');
    (document.querySelector('[data-action="save"]') as HTMLElement).click();

    const err = document.querySelector('.r-edit-err') as HTMLElement | null;
    expect(err).not.toBeNull();
    expect(err!.style.display).not.toBe('none');
    expect(err!.textContent).toMatch(/mm:ss/);
    expect(cta().disabled).toBe(true);
    expect(ob().pbs.k5).toBeUndefined();
  }, 20000);

  it('an unreadable typed time names the format under Build and on leaving the field, without tapping Save', async () => {
    await mount();
    const input = await openPbEditor('pb-k5');
    typeKeys(input, '22.30');

    const hint = document.getElementById('r-continue-hint') as HTMLElement;
    expect(cta().disabled).toBe(true);
    expect(hint.textContent).toBe('Use mm:ss, e.g. 22:30, to continue.');
    expect(hint.textContent).not.toMatch(/Add at least one personal best/);

    input.dispatchEvent(new Event('change', { bubbles: true }));
    const err = document.querySelector('.r-edit-err') as HTMLElement | null;
    expect(err?.style.display).toBe('block');
    expect(err?.textContent).toBe('Use mm:ss, e.g. 22:30.');

    // Correcting the time clears both and lights Build.
    typeKeys(input, '22:30');
    expect(cta().disabled).toBe(false);
    expect(err?.style.display).toBe('none');
    expect(hint.style.display).toBe('none');
  }, 20000);

  it('opening a PB editor and leaving it unchanged does not rewrite the PB or its date', async () => {
    await mount({ pbs: { k5: 1300 }, pbDates: { k5: '2026-05-01T08:00:00Z' } });
    await openPbEditor('pb-k5');
    cta().click();
    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(ob().pbs.k5).toBe(1300);
    expect(ob().pbDates?.k5).toBe('2026-05-01T08:00:00Z');
  }, 20000);
});
