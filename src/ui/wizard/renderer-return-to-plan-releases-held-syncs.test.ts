// @vitest-environment jsdom
/**
 * F8 follow-up. An existing triathlon, cycling or HYROX user who taps Edit
 * settings reloads into the wizard at goals with hasCompletedOnboarding false.
 * The launch Strava sync on that reload is held by the sex gate
 * (trimp-sex-gate.ts rule b: these modes hold until about-you is left).
 * "Return to plan" marks onboarding complete and leaves the wizard without a
 * step change, so before this fix nothing released the held sync: the session
 * got no launch Strava sync at all. The button now releases it, and the
 * released sync runs with the canonical s.biologicalSex.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', () => ({ saveState: vi.fn(), loadState: vi.fn() }));

const edgeCalls: Array<{ fn: string; body: Record<string, unknown> }> = [];
vi.mock('@/data/supabaseClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/supabaseClient')>();
  return {
    ...actual,
    callEdgeFunction: vi.fn(async (fn: string, body: Record<string, unknown>) => {
      edgeCalls.push({ fn, body });
      return [];
    }),
  };
});

vi.mock('@/data/activitySync', () => ({
  processPendingCrossTraining: vi.fn(),
  resetPendingModalGuard: vi.fn(),
}));

// The Return button lands on the Plan view through a dynamic import; the view
// itself is not under test.
vi.mock('@/ui/main-view', () => ({ renderMainView: vi.fn() }));

import { getDefaultState, setState, getState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { Week } from '@/types';
import { renderStep } from './renderer';
import { syncStravaActivities } from '@/data/stravaSync';
import { heldTrimpSyncKeys, _resetHeldTrimpSyncsForTest } from '@/data/trimp-sex-gate';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function editSettingsSessionAt(trainingMode: OnboardingState['trainingMode']): void {
  const s = getDefaultState();
  // Mid-plan: Edit settings (events.ts editSettings) reloads into the wizard
  // at goals with the plan intact and onboarding reopened.
  s.wks = [{ w: 1 } as unknown as Week];
  s.hasCompletedOnboarding = false;
  s.biologicalSex = 'female';
  s.onboarding = {
    ...defaultOnboardingState,
    trainingMode,
    currentStep: 'goals',
    biologicalSex: 'female',
  };
  setState(s);
}

function stravaSyncCalls() {
  return edgeCalls.filter(c => c.fn === 'sync-strava-activities' && c.body.mode === undefined);
}

beforeEach(() => {
  edgeCalls.length = 0;
  _resetHeldTrimpSyncsForTest();
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('Return to plan releases launch syncs the sex gate held mid-wizard', () => {
  it('triathlon Edit settings: the held launch Strava sync runs once Return to plan is tapped', async () => {
    editSettingsSessionAt('triathlon');

    const launch = await syncStravaActivities();
    expect(launch).toEqual({ processed: 0, held: true });
    expect(heldTrimpSyncKeys()).toEqual(['strava-sync']);

    renderStep('goals', getState().onboarding!);
    const btn = document.getElementById('wizard-return-btn');
    expect(btn).not.toBeNull();
    btn!.click();
    await settle();
    await settle();

    expect(getState().hasCompletedOnboarding).toBe(true);
    expect(heldTrimpSyncKeys()).toEqual([]);
    const sent = stravaSyncCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.biological_sex).toBe('female');
  });

  it('HYROX Edit settings: same release on Return to plan', async () => {
    editSettingsSessionAt('hyrox');

    await syncStravaActivities();
    expect(heldTrimpSyncKeys()).toEqual(['strava-sync']);

    renderStep('goals', getState().onboarding!);
    document.getElementById('wizard-return-btn')!.click();
    await settle();
    await settle();

    expect(heldTrimpSyncKeys()).toEqual([]);
    expect(stravaSyncCalls()).toHaveLength(1);
  });
});
