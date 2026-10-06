// @vitest-environment jsdom
/**
 * F8: syncs that stamp iTRIMP are held while the athlete's sex is unknown and
 * the wizard can still ask (trimp-sex-gate.ts). The controller releases them
 * on a step change, so the about-you / schedule answer counts when Continue
 * is pressed rather than on a pill tap the user may still correct.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./renderer', () => ({ renderStep: vi.fn() }));
vi.mock('@/state/persistence', () => ({ saveState: vi.fn() }));

import { getDefaultState, setState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import { updateOnboarding, nextStep, previousStep, completeOnboarding } from './controller';
import { holdUntilTrimpSexKnown, heldTrimpSyncKeys, _resetHeldTrimpSyncsForTest } from '@/data/trimp-sex-gate';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function startWizardAt(onboarding: Partial<OnboardingState>): void {
  const s = getDefaultState();
  s.hasCompletedOnboarding = false;
  s.biologicalSex = undefined;
  s.onboarding = { ...defaultOnboardingState, biologicalSex: undefined, ...onboarding };
  setState(s);
}

let heldRun: ReturnType<typeof vi.fn<() => Promise<undefined>>>;

beforeEach(() => {
  _resetHeldTrimpSyncsForTest();
  heldRun = vi.fn(async () => undefined);
});

describe('wizard releases syncs held for the athlete\'s sex when the answer is final', () => {
  it('triathlon about-you: the pill tap keeps the sync held, Continue releases it', async () => {
    startWizardAt({ trainingMode: 'triathlon', currentStep: 'about-you', age: 34 });
    holdUntilTrimpSexKnown('strava-sync', heldRun);

    updateOnboarding({ biologicalSex: 'female' });
    await settle();
    expect(heldRun).not.toHaveBeenCalled();

    nextStep(); // about-you -> triathlon-setup
    await settle();
    expect(heldRun).toHaveBeenCalledTimes(1);
    expect(heldTrimpSyncKeys()).toEqual([]);
  });

  it('triathlon with a Strava-prefilled sex: still held on about-you, released when Continue leaves it', async () => {
    startWizardAt({ trainingMode: 'triathlon', currentStep: 'connect-data', biologicalSex: 'female', age: 34 });
    holdUntilTrimpSexKnown('strava-backfill', heldRun);

    nextStep(); // connect-data -> about-you (prefill shown for confirmation)
    await settle();
    expect(heldRun).not.toHaveBeenCalled();

    nextStep(); // about-you -> triathlon-setup
    await settle();
    expect(heldRun).toHaveBeenCalledTimes(1);
  });

  it('running schedule: Continue to review releases the held sync before review renders', async () => {
    startWizardAt({ trainingMode: 'running', currentStep: 'schedule', age: 34 });
    holdUntilTrimpSexKnown('strava-backfill', heldRun);

    updateOnboarding({ biologicalSex: 'female' });
    nextStep(); // schedule -> review
    await settle();
    expect(heldRun).toHaveBeenCalledTimes(1);
  });

  it('going Back from about-you without answering keeps the sync held', async () => {
    startWizardAt({ trainingMode: 'hyrox', currentStep: 'about-you' });
    holdUntilTrimpSexKnown('strava-sync', heldRun);

    previousStep(); // about-you -> connect-data
    await settle();
    expect(heldRun).not.toHaveBeenCalled();
    expect(heldTrimpSyncKeys()).toEqual(['strava-sync']);
  });

  it('Just-Track releases on the next step with no sex: the wizard never asks', async () => {
    startWizardAt({ currentStep: 'goals' });
    holdUntilTrimpSexKnown('strava-sync', heldRun);

    updateOnboarding({ trainingMode: 'fitness', trainingFocus: 'track', trackOnly: true });
    nextStep(); // goals -> connect-data
    await settle();
    expect(heldRun).toHaveBeenCalledTimes(1);
  });

  it('completing onboarding releases anything still held', async () => {
    startWizardAt({ currentStep: 'connect-data' });
    holdUntilTrimpSexKnown('apple-workouts', heldRun);

    completeOnboarding();
    await settle();
    expect(heldRun).toHaveBeenCalledTimes(1);
  });
});
