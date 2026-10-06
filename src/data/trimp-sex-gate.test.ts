/**
 * The wizard runs connect-data before the sex question (about-you for
 * triathlon, cycling and HYROX; schedule for running). A sync that stamps
 * iTRIMP while no sex resolves sends none, the rows are cached with the male
 * β 1.92, and a female athlete's history then decodes about 1.23× high. The
 * gate holds such syncs until the sex is known or the question is behind the
 * user (F8, follow-up to F5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tracked = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/app/runtime', () => ({
  trackStartupTask: <T>(p: Promise<T>) => { tracked.count++; return p; },
}));

import {
  isTrimpSexPending,
  holdUntilTrimpSexKnown,
  releaseHeldTrimpSyncs,
  heldTrimpSyncKeys,
  _resetHeldTrimpSyncsForTest,
  type TrimpSexGateSource,
} from './trimp-sex-gate';
import type { OnboardingStep } from '@/types/onboarding';

function wizardAt(step: OnboardingStep, extra: Partial<NonNullable<TrimpSexGateSource['onboarding']>> = {}): TrimpSexGateSource {
  return { hasCompletedOnboarding: false, biologicalSex: undefined, onboarding: { currentStep: step, ...extra } };
}

beforeEach(() => {
  _resetHeldTrimpSyncsForTest();
  tracked.count = 0;
});

describe('isTrimpSexPending: hold iTRIMP stamping while the sex question is still ahead', () => {
  it('connect-data with no sex from Strava or HealthKit holds', () => {
    expect(isTrimpSexPending(wizardAt('connect-data'))).toBe(true);
  });

  it('every step at or before about-you / schedule holds while unanswered', () => {
    for (const step of ['welcome', 'goals', 'connect-data', 'manual-entry', 'race-target', 'schedule', 'about-you'] as const) {
      expect(isTrimpSexPending(wizardAt(step)), step).toBe(true);
    }
  });

  it('the wizard answer opens the gate, including "prefer not to say"', () => {
    expect(isTrimpSexPending(wizardAt('about-you', { biologicalSex: 'female' }))).toBe(false);
    expect(isTrimpSexPending(wizardAt('schedule', { biologicalSex: 'prefer_not_to_say' }))).toBe(false);
  });

  it('running: a HealthKit-seeded s.biologicalSex opens the gate at connect-data (schedule will not ask again)', () => {
    const s = wizardAt('connect-data', { trainingMode: 'running' });
    s.biologicalSex = 'female';
    expect(isTrimpSexPending(s)).toBe(false);
  });

  it('running: a Strava-prefilled answer opens the gate at connect-data', () => {
    expect(isTrimpSexPending(wizardAt('connect-data', { trainingMode: null, biologicalSex: 'female' }))).toBe(false);
  });

  it('triathlon, cycling and HYROX: a prefilled sex still holds until about-you is left, because about-you shows it for confirmation', () => {
    for (const mode of ['triathlon', 'cycling', 'hyrox'] as const) {
      for (const step of ['goals', 'connect-data', 'about-you'] as const) {
        const s = wizardAt(step, { trainingMode: mode, biologicalSex: 'female' });
        s.biologicalSex = 'female';
        expect(isTrimpSexPending(s), `${mode} at ${step}`).toBe(true);
      }
      expect(isTrimpSexPending(wizardAt(`${mode}-setup` as OnboardingStep, { trainingMode: mode, biologicalSex: 'female' })), `${mode} after about-you`).toBe(false);
    }
  });

  it('steps after the question never hold, so the review-step backfill always runs', () => {
    for (const step of ['review', 'commute', 'initializing', 'plan-preview-v2', 'triathlon-setup', 'hyrox-setup', 'cycling-setup', 'coach-contract'] as const) {
      expect(isTrimpSexPending(wizardAt(step)), step).toBe(false);
    }
  });

  it('Just-Track never holds: it skips about-you and schedule, so no answer is coming', () => {
    expect(isTrimpSexPending(wizardAt('connect-data', { trackOnly: true }))).toBe(false);
  });

  it('after onboarding never holds, with or without a sex, in any mode (editing goals keeps s.biologicalSex canonical)', () => {
    expect(isTrimpSexPending({ hasCompletedOnboarding: true, onboarding: { currentStep: 'main-view' } })).toBe(false);
    expect(isTrimpSexPending({ hasCompletedOnboarding: true, onboarding: { currentStep: 'about-you', trainingMode: 'triathlon' } })).toBe(false);
  });

  it('a fresh state before the wizard starts holds', () => {
    expect(isTrimpSexPending({ hasCompletedOnboarding: false })).toBe(true);
  });
});

describe('held syncs run once, after the sex resolves', () => {
  it('a held sync does not run while the sex is pending and runs once when released after the answer', async () => {
    const run = vi.fn(async () => undefined);
    holdUntilTrimpSexKnown('strava-sync', run);
    holdUntilTrimpSexKnown('strava-sync', run); // second hold collapses into the first

    const s = wizardAt('about-you');
    expect(await releaseHeldTrimpSyncs(s)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(heldTrimpSyncKeys()).toEqual(['strava-sync']);

    s.onboarding!.biologicalSex = 'female';
    expect(await releaseHeldTrimpSyncs(s)).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(heldTrimpSyncKeys()).toEqual([]);

    expect(await releaseHeldTrimpSyncs(s)).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('released runs are registered as startup tasks, so the review step waits for them', async () => {
    holdUntilTrimpSexKnown('strava-backfill', async () => undefined);
    holdUntilTrimpSexKnown('apple-workouts', async () => undefined);
    await releaseHeldTrimpSyncs(wizardAt('review'));
    expect(tracked.count).toBe(2);
  });

  it('a failing held run does not stop the others', async () => {
    const ok = vi.fn(async () => undefined);
    holdUntilTrimpSexKnown('strava-sync', async () => { throw new Error('edge down'); });
    holdUntilTrimpSexKnown('strava-backfill', ok);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await releaseHeldTrimpSyncs(wizardAt('review'))).toBe(2);
    expect(ok).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
