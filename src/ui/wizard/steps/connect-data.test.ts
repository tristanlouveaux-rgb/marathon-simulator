// @vitest-environment jsdom
/**
 * Regression guard for the onboarding "Show us where you're at" connect step.
 *
 * This flow has broken repeatedly (Apple spinner stick, missing auto-advance,
 * connect-memory parity, skip routing). The native HealthKit bridge can only be
 * exercised on a device, so here we mock `isNativeiOS` + `connectAppleHealth` and
 * assert the LOGIC every branch depends on: phase transitions, the auto-advance
 * contract, the deliberate-skip double-tap, and persisted connect memory on re-entry.
 *
 * What this does NOT cover (device-only): the real HealthKit permission sheet, the
 * deny-vs-no-data ambiguity, and an actual physiology sync. See the device checklist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

const h = vi.hoisted(() => {
  const store: { state: any } = { state: {} };
  return {
    store,
    getState: vi.fn(() => store.state),
    updateState: vi.fn((patch: any) => { store.state = { ...store.state, ...patch }; }),
    saveState: vi.fn(),
    nextStep: vi.fn(),
    goToStep: vi.fn(),
    getOnboardingState: vi.fn(() => store.state.onboarding),
    updateOnboarding: vi.fn((updates: any) => {
      store.state = { ...store.state, onboarding: { ...(store.state.onboarding ?? {}), ...updates } };
    }),
    // The account-save overlay no-ops for non-anonymous sessions and otherwise
    // invokes its callback on close — mirror that by calling the callback straight away.
    maybeOfferAccountSave: vi.fn((cb: () => void) => cb()),
    isNativeiOS: vi.fn(() => true),
    connectAppleHealth: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }),
    hasPhysiologySource: vi.fn(() => false),
    isStravaConnected: vi.fn(async () => false),
  };
});

vi.mock('@/state/store', () => ({ getState: h.getState, updateState: h.updateState }));
vi.mock('@/state/persistence', () => ({ saveState: h.saveState }));
vi.mock('../controller', () => ({
  nextStep: h.nextStep,
  goToStep: h.goToStep,
  getOnboardingState: h.getOnboardingState,
  updateOnboarding: h.updateOnboarding,
}));
vi.mock('../save-account-overlay', () => ({ maybeOfferAccountSave: h.maybeOfferAccountSave }));
vi.mock('../renderer', () => ({ renderProgressIndicator: () => '', renderBackButton: () => '' }));
vi.mock('@/ui/page-flair', () => ({
  buildRingBackground: () => '', buildSunGlint: () => '', buildAtmosphereBase: () => '',
}));
vi.mock('@/data/appleHealthSync', () => ({
  isNativeiOS: h.isNativeiOS, connectAppleHealth: h.connectAppleHealth,
  getLastApplePhysiologyDiag: () => '',
}));
vi.mock('@/data/healthExtras', () => ({ openAppSettings: vi.fn() }));
vi.mock('@/data/sources', () => ({ hasPhysiologySource: h.hasPhysiologySource }));
vi.mock('@/ui/import-activity-modal', () => ({ openImportActivityModal: vi.fn() }));
vi.mock('@/ui/strava-history-guide', () => ({ openStravaHistoryGuide: vi.fn() }));
vi.mock('@/ui/garmin-apple-health-guide', () => ({ openGarminAppleHealthGuide: vi.fn() }));
vi.mock('@/constants/access-codes', () => ({ isValidAccessCode: () => false, isReviewerCode: () => false }));
vi.mock('@/ui/strava-brand', () => ({ connectWithStravaButton: () => '<button id="cd-connect-strava"></button>' }));
vi.mock('@/data/stravaSync', () => ({ startStravaConnect: vi.fn(async () => {}) }));
vi.mock('@/data/garminOAuth', () => ({ startGarminConnect: vi.fn(async () => {}) }));
vi.mock('@/data/supabaseClient', () => ({ isStravaConnected: h.isStravaConnected, resetStravaCache: vi.fn() }));
vi.mock('@/constants/feature-flags', () => ({ GARMIN_CONNECT_ENABLED: false }));

import { renderConnectData } from './connect-data';

/** Let the async connect chain (Promise.race → markAppleHealthConnected → nextStep) settle. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function render(onboarding: Partial<OnboardingState> = {}, rootState: Record<string, any> = {}): HTMLElement {
  h.store.state = { ...rootState, onboarding: { currentStep: 'connect-data', ...onboarding } };
  const container = document.createElement('div');
  document.body.appendChild(container);
  renderConnectData(container, h.store.state.onboarding as OnboardingState);
  return container;
}

function click(selector: string): void {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`element not found: ${selector}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function continueBtn(): HTMLButtonElement {
  return document.getElementById('cd-continue') as HTMLButtonElement;
}

function isVisible(id: string): boolean {
  const el = document.getElementById(id);
  return !!el && el.style.display !== 'none' && el.style.display !== '';
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  // jsdom's default location has an empty query string, so the ?strava/?garmin
  // OAuth-return branch in renderConnectData is a no-op — no history mutation needed.
  h.isNativeiOS.mockReturnValue(true);
  h.connectAppleHealth.mockResolvedValue({ ok: true });
  h.hasPhysiologySource.mockReturnValue(false);
  h.isStravaConnected.mockResolvedValue(false);
});

describe('connect-data — Apple Health picker tile', () => {
  it('auto-advances onboarding after a successful connect (the fix)', async () => {
    render();
    click('.cd-watch[data-watch="apple"]');
    await flush();

    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(h.store.state.onboarding.skippedStrava).toBe(false);
    // Continue is morphed to the dark CTA even though we advance straight through
    // (visible behind the account-save overlay for anonymous users).
    expect(continueBtn().classList.contains('post')).toBe(true);
  });

  it('shows the recovery card and does NOT advance when no data comes through', async () => {
    h.connectAppleHealth.mockResolvedValue({ ok: false, reason: 'no-data' });
    render();
    click('.cd-watch[data-watch="apple"]');
    await flush();

    expect(isVisible('cd-apple-recovery')).toBe(true);
    expect(h.nextStep).not.toHaveBeenCalled();
  });

  it('surfaces the unreachable-HealthKit copy on a sync-error and does NOT advance', async () => {
    h.connectAppleHealth.mockResolvedValue({ ok: false, reason: 'sync-error' });
    render();
    click('.cd-watch[data-watch="apple"]');
    await flush();

    expect(isVisible('cd-apple-recovery')).toBe(true);
    expect(document.getElementById('cd-apple-recovery-sub')?.textContent ?? '')
      .toMatch(/could not be reached/i);
    expect(h.nextStep).not.toHaveBeenCalled();
  });

  it('falls back to the "open the iOS app" card on web, never the native connect', async () => {
    h.isNativeiOS.mockReturnValue(false);
    render();
    click('.cd-watch[data-watch="apple"]');
    await flush();

    expect(h.connectAppleHealth).not.toHaveBeenCalled();
    expect(isVisible('cd-apple-web')).toBe(true);
    expect(h.nextStep).not.toHaveBeenCalled();
  });
});

describe('connect-data — tile routing', () => {
  it('routes the Garmin tile to the history hub (no advance)', () => {
    render();
    // First data-watch="other" tile is Garmin.
    click('.cd-watch[data-watch="other"]');

    expect(isVisible('cd-history')).toBe(true);
    expect(document.getElementById('cd-picker')?.style.display).toBe('none');
    expect(h.nextStep).not.toHaveBeenCalled();
  });

  it('routes the "No watch yet" tile to the same history hub', () => {
    render();
    const tiles = document.querySelectorAll('.cd-watch[data-watch="other"]');
    // The third tile overall (second data-watch="other") is "No watch yet".
    (tiles[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(isVisible('cd-history')).toBe(true);
    expect(h.nextStep).not.toHaveBeenCalled();
  });
});

describe('connect-data — Continue / deliberate skip', () => {
  it('requires a deliberate second tap to skip with no data source', () => {
    render();

    click('#cd-continue');
    expect(h.nextStep).not.toHaveBeenCalled();
    expect(continueBtn().textContent).toBe('Continue without data');

    click('#cd-continue');
    expect(h.store.state.onboarding.skippedStrava).toBe(true);
    expect(h.nextStep).toHaveBeenCalledTimes(1);
  });

  it('advances on the FIRST tap when Apple Health is already connected', () => {
    render({}, { appleHealthConnected: true });

    click('#cd-continue');
    expect(h.nextStep).toHaveBeenCalledTimes(1);
    expect(h.store.state.onboarding.skippedStrava).toBe(false);
  });
});

describe('connect-data — persisted connect memory on re-entry', () => {
  it('shows the connected state when appleHealthConnected is set but no physiology source (parity fix)', () => {
    // Supplementary-Apple user: a non-Apple primary holds the physiology source,
    // so hasPhysiologySource('apple') is false but the device-local flag is true.
    render({ chosenWatch: 'apple' }, { appleHealthConnected: true });
    expect(continueBtn().classList.contains('post')).toBe(true);
  });

  it('shows the connected state when Apple IS the physiology source', () => {
    h.hasPhysiologySource.mockReturnValue(true);
    render({ chosenWatch: 'apple' });
    expect(continueBtn().classList.contains('post')).toBe(true);
  });

  it('does NOT pre-arm Continue when nothing is connected', () => {
    render({ chosenWatch: 'apple' });
    expect(continueBtn().classList.contains('post')).toBe(false);
    expect(continueBtn().classList.contains('pre')).toBe(true);
  });
});
