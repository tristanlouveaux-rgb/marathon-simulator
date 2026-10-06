// @vitest-environment jsdom
/**
 * F8 (follow-up to F5). The wizard runs connect-data before the sex question
 * (about-you for triathlon / cycling / HYROX, schedule for running). With no
 * sex from Strava or HealthKit, the post-connect 28-day sync, and the launch
 * backfill that fires on the OAuth return launch before the Strava prefill
 * lands, sent biological_sex undefined. The edge function stamped those rows
 * with the male β 1.92 and cached them, so once the athlete answered Female
 * they decoded about 1.23× high (123.5 TSS for an hour at LTHR at 168/50/190).
 * Both Strava producers now hold until the sex resolves and then run with it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimulatorState } from '@/types';
import type { OnboardingStep } from '@/types/onboarding';
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

import { syncStravaActivities, backfillStravaHistory, applyStravaAthletePrefill } from './stravaSync';
import { releaseHeldTrimpSyncs, heldTrimpSyncKeys, _resetHeldTrimpSyncsForTest } from './trimp-sex-gate';

function wizardAt(step: OnboardingStep): SimulatorState {
  const s = getDefaultState();
  s.hasCompletedOnboarding = false;
  s.biologicalSex = undefined;
  s.onboarding = { ...defaultOnboardingState, currentStep: step, biologicalSex: undefined };
  return s;
}

function stravaCalls(mode: 'backfill' | undefined) {
  return calls.filter(c => c.fn === 'sync-strava-activities' && c.body.mode === mode);
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  calls.length = 0;
  _resetHeldTrimpSyncsForTest();
});

describe('Strava producers hold until the athlete\'s sex is known (F8)', () => {
  it('the post-connect 28-day sync at connect-data with no sex calls nothing', async () => {
    mockState = wizardAt('connect-data');
    const result = await syncStravaActivities();
    expect(result).toEqual({ processed: 0, held: true });
    expect(calls).toHaveLength(0);
    expect(heldTrimpSyncKeys()).toContain('strava-sync');
  });

  it('the held 28-day sync runs with female once the about-you answer lands', async () => {
    mockState = wizardAt('connect-data');
    await syncStravaActivities();
    mockState.onboarding = { ...mockState.onboarding!, currentStep: 'triathlon-setup', biologicalSex: 'female' };
    expect(await releaseHeldTrimpSyncs(mockState)).toBe(1);
    const sent = stravaCalls(undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.biological_sex).toBe('female');
  });

  it('a held 52-week launch backfill and a later 16-week call run once, over 52 weeks, with the answer', async () => {
    mockState = wizardAt('connect-data');
    expect((await backfillStravaHistory(52)).held).toBe(true);
    expect((await backfillStravaHistory(16)).held).toBe(true);
    expect(calls).toHaveLength(0);
    mockState.onboarding = { ...mockState.onboarding!, biologicalSex: 'female' };
    await releaseHeldTrimpSyncs(mockState);
    const sent = stravaCalls('backfill');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.weeks).toBe(52);
    expect(sent[0].body.biological_sex).toBe('female');
  });

  it('running: the Strava profile prefill on the OAuth return releases the held launch backfill with the Strava sex', async () => {
    mockState = wizardAt('connect-data');
    await backfillStravaHistory(52);
    applyStravaAthletePrefill('F', '61.44');
    await settle();
    expect(mockState.onboarding!.biologicalSex).toBe('female');
    expect(mockState.onboarding!.bodyWeightKg).toBe(61.4);
    const sent = stravaCalls('backfill');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.biological_sex).toBe('female');
  });

  it('triathlon: a Strava-prefilled sex keeps the backfill held until about-you is left, and it then runs with the confirmed answer', async () => {
    mockState = wizardAt('connect-data');
    mockState.onboarding!.trainingMode = 'triathlon';
    await backfillStravaHistory(52);
    applyStravaAthletePrefill('M', null);
    await settle();
    expect(mockState.onboarding!.biologicalSex).toBe('male');
    expect(calls).toHaveLength(0);

    // about-you shows the prefill; the athlete corrects it and presses Continue.
    mockState.onboarding = { ...mockState.onboarding!, biologicalSex: 'female', currentStep: 'triathlon-setup' };
    expect(await releaseHeldTrimpSyncs(mockState)).toBe(1);
    const sent = stravaCalls('backfill');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.biological_sex).toBe('female');
  });

  it('a Strava profile with no sex keeps the backfill held for the wizard question', async () => {
    mockState = wizardAt('connect-data');
    await backfillStravaHistory(52);
    applyStravaAthletePrefill(null, null);
    await settle();
    expect(calls).toHaveLength(0);
    expect(heldTrimpSyncKeys()).toEqual(['strava-backfill']);
  });

  it('the prefill never overwrites an answer the user already gave', () => {
    mockState = wizardAt('about-you');
    mockState.onboarding!.biologicalSex = 'female';
    applyStravaAthletePrefill('M', null);
    expect(mockState.onboarding!.biologicalSex).toBe('female');
  });

  it('the review-step backfill is never held, even for Just-Track with no sex', async () => {
    mockState = wizardAt('review');
    mockState.onboarding!.trackOnly = true;
    const result = await backfillStravaHistory(26);
    expect(result.held).toBeUndefined();
    const sent = stravaCalls('backfill');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.biological_sex).toBeUndefined();
  });

  it('after onboarding the sync runs at once, sex or not', async () => {
    mockState = wizardAt('main-view');
    mockState.hasCompletedOnboarding = true;
    const result = await syncStravaActivities();
    expect(result.held).toBeUndefined();
    expect(stravaCalls(undefined)).toHaveLength(1);
  });
});
