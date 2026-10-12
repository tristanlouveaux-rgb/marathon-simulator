// @vitest-environment jsdom
/**
 * HYROX setup: Division row and the division-aware Pro note (26/27 rulebooks).
 *
 * Contract:
 *   - Doubles always shows the Division row (Women / Men / Mixed), prefilled
 *     from biological sex; Mixed is hidden for Pro Doubles (no Pro Mixed).
 *   - Singles shows the row only when biological sex is unset or
 *     'prefer_not_to_say' (Women / Men).
 *   - The Pro note gives the athlete's own division loads: Women Pro is not
 *     told the Men Pro weights.
 */
import { describe, it, expect, vi } from 'vitest';
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

import { renderHyroxSetup, setupBand } from './hyrox-setup';
import { HYROX_TOTAL_PERCENTILE_TABLES } from '@/data/hyrox-population-distributions';

function mount(onboarding: Partial<OnboardingState> = {}): void {
  h.store.state = {
    onboarding: { currentStep: 'hyrox-setup', trainingMode: 'hyrox', customRaceDate: null, ...onboarding },
  };
  document.body.innerHTML = '<div id="app-root"></div>';
  renderHyroxSetup(document.getElementById('app-root')!, h.store.state.onboarding as OnboardingState);
}

const ob = () => h.store.state.onboarding as OnboardingState;
const visible = (el: HTMLElement | null): boolean => !!el && el.style.display !== 'none';
const row = () => document.getElementById('hx-division-row');
const btn = (d: string) => document.querySelector(`[data-division="${d}"]`) as HTMLButtonElement;
const formatBtn = (f: string) => document.querySelector(`[data-format="${f}"]`) as HTMLButtonElement;
const proNote = () => (document.getElementById('hx-pro-note')?.textContent ?? '').trim();

describe('hyrox-setup: Division row', () => {
  it('singles with a known biological sex shows no Division row', () => {
    mount({ hyroxFormat: 'open_singles', biologicalSex: 'female' });
    expect(visible(row())).toBe(false);
  });

  it('singles with prefer_not_to_say asks Women / Men, Mixed hidden', () => {
    mount({ hyroxFormat: 'open_singles', biologicalSex: 'prefer_not_to_say' });
    expect(visible(row())).toBe(true);
    expect(visible(btn('women'))).toBe(true);
    expect(visible(btn('men'))).toBe(true);
    expect(visible(btn('mixed'))).toBe(false);
    btn('women').click();
    expect(ob().hyroxDivision).toBe('women');
    expect(btn('women').classList.contains('active')).toBe(true);
  });

  it('Open Doubles shows Women / Men / Mixed, prefilled from biological sex', () => {
    mount({ hyroxFormat: 'open_doubles', biologicalSex: 'male' });
    expect(visible(row())).toBe(true);
    expect(visible(btn('mixed'))).toBe(true);
    expect(btn('men').classList.contains('active')).toBe(true);
    btn('mixed').click();
    expect(ob().hyroxDivision).toBe('mixed');
    expect(btn('mixed').classList.contains('active')).toBe(true);
    expect(document.getElementById('hx-division-hint')!.textContent).toMatch(/Men Open loads for both partners/);
  });

  it('switching to Pro Doubles hides Mixed and drops a Mixed pick', () => {
    mount({ hyroxFormat: 'open_doubles', biologicalSex: 'female', hyroxDivision: 'mixed' });
    formatBtn('pro_doubles').click();
    expect(visible(btn('mixed'))).toBe(false);
    expect(ob().hyroxDivision).toBeUndefined();
    // Falls back to the sex-derived division.
    expect(btn('women').classList.contains('active')).toBe(true);
  });

  it('switching from doubles to singles hides the row when sex is known', () => {
    mount({ hyroxFormat: 'open_doubles', biologicalSex: 'female' });
    formatBtn('open_singles').click();
    expect(visible(row())).toBe(false);
  });
});

describe('hyrox-setup: Pro note gives the athlete\'s own division loads', () => {
  it('Women Pro sees the Women Pro loads, not the Men Pro ones', () => {
    mount({ hyroxFormat: 'pro_singles', biologicalSex: 'female' });
    expect(proNote()).toBe('Women Pro loads: sled push 152 kg, sled pull 103 kg, farmers carry 2 × 24 kg, sandbag 20 kg, wall ball 6 kg to 2.70 m.');
  });

  it('Men Pro sees the Men Pro loads', () => {
    mount({ hyroxFormat: 'pro_singles', biologicalSex: 'male' });
    expect(proNote()).toContain('Men Pro loads: sled push 202 kg, sled pull 153 kg, farmers carry 2 × 32 kg, sandbag 30 kg, wall ball 9 kg to 3.00 m');
  });

  it('unknown sex asks for a division, then names its loads', () => {
    mount({ hyroxFormat: 'pro_singles', biologicalSex: 'prefer_not_to_say' });
    expect(proNote()).toMatch(/depend on division/);
    btn('men').click();
    expect(proNote()).toMatch(/^Men Pro loads: sled push 202 kg/);
  });

  it('the Pro note follows a format change', () => {
    mount({ hyroxFormat: 'open_doubles', biologicalSex: 'female' });
    formatBtn('pro_doubles').click();
    expect(visible(document.getElementById('hx-pro-note'))).toBe(true);
    expect(proNote()).toMatch(/^Doubles Women Pro loads: sled push 152 kg/);
  });

  it('no copy shows the unofficial doubles 10-second rule', () => {
    mount({ hyroxFormat: 'open_doubles', biologicalSex: 'female' });
    expect(document.body.textContent ?? '').not.toMatch(/10.?second/i);
  });
});

describe('hyrox-setup: band-driven defaults use the onboarding banding rule', () => {
  const p50 = (f: 'open_singles' | 'open_doubles') => HYROX_TOTAL_PERCENTILE_TABLES[f].find(([, p]) => p === 50)![0];
  it('a doubles-median time for a doubles target bands like the singles median', () => {
    expect(setupBand({ previousHyroxTimeSec: p50('open_doubles'), hyroxPreviousTimeFormat: 'open_doubles', hyroxFormat: 'open_doubles' }))
      .toBe(setupBand({ previousHyroxTimeSec: p50('open_singles'), hyroxPreviousTimeFormat: 'open_singles', hyroxFormat: 'open_singles' }));
  });
  it('before the previous format is picked, the time as entered', () => {
    expect(setupBand({ previousHyroxTimeSec: 75 * 60, hyroxFormat: 'open_doubles' })).toBe('advanced');
    expect(setupBand({ hyroxFormat: 'open_doubles' })).toBeNull();
  });
});
