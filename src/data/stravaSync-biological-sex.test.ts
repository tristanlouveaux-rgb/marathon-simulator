// @vitest-environment jsdom
/**
 * The Strava edge function stamps iTRIMP with the β of the biological_sex the
 * client sends, and caches each row (with its zones) forever: backfill skips
 * cached-with-zones rows and the standalone sync returns cached.itrimp. So the
 * sex sent must be the one the normaliser will later decode with.
 *
 * During the onboarding wizard the user's answer lives only on
 * s.onboarding.biologicalSex; s.biologicalSex is filled at plan initialisation.
 * Both onboarding producers (the post-connect sync and the review-step
 * backfill) used to send s.biologicalSex, i.e. undefined, so a female athlete's
 * onboarding history was stamped with the male β 1.92 and, once
 * s.biologicalSex was set, decoded with the female normaliser at about 1.23×
 * (123.5 TSS for an hour at LTHR at 168/50/190). Audit B12 follow-up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimulatorState } from '@/types';
import { getDefaultState } from '@/state/store';
import { defaultOnboardingState } from '@/types/onboarding';

let mockState: SimulatorState;

vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return {
    ...actual,
    getMutableState: () => mockState,
    getState: () => mockState,
    saveState: vi.fn(),
  };
});

const calls: Array<{ fn: string; body: Record<string, unknown> }> = [];

vi.mock('./supabaseClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supabaseClient')>();
  return {
    ...actual,
    callEdgeFunction: vi.fn(async (fn: string, body: Record<string, unknown>) => {
      calls.push({ fn, body });
      return body.mode === 'backfill'
        ? { processed: 0, withHRStream: 0, withAvgHR: 0, hasHRMonitor: false }
        : [];
    }),
  };
});

vi.mock('./activitySync', () => ({
  processPendingCrossTraining: vi.fn(),
  resetPendingModalGuard: vi.fn(),
}));

import { syncStravaActivities, backfillStravaHistory } from './stravaSync';

function midWizardState(onboardingSex: 'male' | 'female' | 'prefer_not_to_say' | undefined): SimulatorState {
  const s = getDefaultState();
  s.hasCompletedOnboarding = false;
  s.biologicalSex = undefined;
  s.onboarding = { ...defaultOnboardingState, biologicalSex: onboardingSex };
  return s;
}

function sentSex(mode: 'backfill' | undefined): unknown {
  const call = calls.find(c => c.fn === 'sync-strava-activities' && c.body.mode === mode);
  expect(call).toBeDefined();
  return call!.body.biological_sex;
}

beforeEach(() => {
  calls.length = 0;
});

describe('onboarding Strava producers send the wizard\'s sex answer (the β the normaliser decodes with)', () => {
  it('review-step backfill sends female when the answer is only on s.onboarding', async () => {
    mockState = midWizardState('female');
    await backfillStravaHistory(16);
    expect(sentSex('backfill')).toBe('female');
  });

  it('post-connect 28-day sync sends female when the answer is only on s.onboarding', async () => {
    mockState = midWizardState('female');
    await syncStravaActivities();
    expect(sentSex(undefined)).toBe('female');
  });

  it('mid-wizard, the wizard answer beats a HealthKit-seeded s.biologicalSex (plan init will overwrite it)', async () => {
    mockState = midWizardState('female');
    mockState.biologicalSex = 'male';
    await backfillStravaHistory(16);
    expect(sentSex('backfill')).toBe('female');
  });

  it('after onboarding, s.biologicalSex is what is sent', async () => {
    mockState = midWizardState('male');
    mockState.hasCompletedOnboarding = true;
    mockState.biologicalSex = 'female';
    await syncStravaActivities();
    expect(sentSex(undefined)).toBe('female');
  });

  it('no answer anywhere, with no question coming (Just-Track), sends nothing (edge function defaults to β 1.92, as does the normaliser)', async () => {
    // While a question is still ahead the backfill is held instead
    // (stravaSync-held-until-sex.test.ts). Just-Track never asks, so the blank
    // answer is final and the backfill runs.
    mockState = midWizardState(undefined);
    mockState.onboarding!.trackOnly = true;
    await backfillStravaHistory(16);
    expect(sentSex('backfill')).toBeUndefined();
  });
});
