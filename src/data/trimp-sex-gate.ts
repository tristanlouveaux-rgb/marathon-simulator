/**
 * trimp-sex-gate.ts
 * =================
 * Holds back iTRIMP-stamping syncs while the onboarding wizard can still set
 * or change the athlete's sex. Tracking side: this decides WHEN an ingested
 * activity's load is stamped, not what the plan prescribes.
 *
 * Why it exists: the Strava edge function stamps each activity's iTRIMP with
 * the β of the biological_sex the client sends, and caches the row with that
 * β permanently (backfill skips cached-with-zones rows, the standalone sync
 * returns cached.itrimp). Apple workouts are stamped on the client and
 * upserted into garmin_activities the same way, and after the first backfill
 * (364 days) only the latest 14 are read again, unless the user runs the
 * Account full-history sync. The wizard runs connect-data BEFORE the sex
 * question (about-you for triathlon, cycling and HYROX; schedule for running
 * and fitness). When neither Strava nor HealthKit supplies a sex, a sync that
 * runs at connect-data (the post-connect 28-day sync, the launch backfill on
 * the OAuth return launch, a mid-wizard relaunch) sends none, the rows are
 * stamped with the male β 1.92, and once a female athlete answers, the
 * normaliser (β 1.67, trimp.ts resolveBiologicalSex) decodes them
 * e^(0.25·hrr) high: about 1.23× for an hour at LTHR at 168/50/190.
 *
 * How: each producer asks isTrimpSexPending() first. If it is pending, the
 * producer registers a resume under a key (repeat calls collapse to one run)
 * and returns without calling the edge function or HealthKit.
 * releaseHeldTrimpSyncs() runs everything held once the gate opens. It is
 * called where the answer becomes final: a wizard step change (so the about-you
 * or schedule answer counts when the user presses Continue, not on a pill tap
 * they may correct), onboarding completion, the mid-plan "Return to plan"
 * exit from an Edit settings session (renderer.ts), the Strava profile
 * prefill on the OAuth return, and the HealthKit characteristics seed.
 *
 * A sex prefilled by Strava or HealthKit is final for running and fitness
 * (schedule hides the question once a sex is known) but not for triathlon,
 * cycling and HYROX: about-you shows the prefill as a selected pill the
 * athlete can change, so those modes hold until about-you is left.
 *
 * Not held: file imports on connect-data (fitImport.ts). They are
 * user-initiated, are not written to garmin_activities, and are converted to
 * weekly TSS at import time (aggregateHistoryFromRows) with the same
 * unresolved sex on both sides of the conversion. Rows cached before this gate
 * existed are a separate server decision.
 */

import { resolveBiologicalSex, type BiologicalSex } from '@/calculations/trimp';
import { trackStartupTask } from '@/app/runtime';
import type { OnboardingState, OnboardingStep } from '@/types/onboarding';

/** The state fields the gate reads. A SimulatorState satisfies it. */
export interface TrimpSexGateSource {
  biologicalSex?: BiologicalSex | 'prefer_not_to_say' | null;
  hasCompletedOnboarding?: boolean;
  onboarding?: {
    biologicalSex?: BiologicalSex | 'prefer_not_to_say' | null;
    currentStep?: OnboardingStep;
    trackOnly?: boolean;
    trainingMode?: OnboardingState['trainingMode'];
  } | null;
}

/**
 * Wizard steps that sit at or before a sex question in at least one flow
 * (controller.ts nextStep): about-you asks it for triathlon, cycling and
 * HYROX; schedule asks it for running and fitness (only when no sex is known
 * yet). Both block Continue until it is answered. Every other step comes
 * after the question in every flow that reaches it, or belongs to Just-Track,
 * which never asks. An unlisted step does not hold, so a new step added later
 * keeps today's sync timing instead of stalling a sync.
 */
const STEPS_AT_OR_BEFORE_SEX_QUESTION: ReadonlySet<OnboardingStep> = new Set<OnboardingStep>([
  'welcome',
  'goals',
  'connect-data',
  'manual-entry',
  'race-target',
  'schedule',
  'about-you',
]);

/** Modes whose flow passes through about-you (controller.ts nextStep). */
const ABOUT_YOU_MODES: ReadonlySet<NonNullable<OnboardingState['trainingMode']>> = new Set([
  'triathlon',
  'cycling',
  'hyrox',
]);

/** Steps at or before about-you in the triathlon, cycling and HYROX flows:
 *  goals → connect-data → about-you (manual-entry is never visited there). */
const STEPS_AT_OR_BEFORE_ABOUT_YOU: ReadonlySet<OnboardingStep> = new Set<OnboardingStep>([
  'welcome',
  'goals',
  'connect-data',
  'about-you',
]);

/**
 * True while an iTRIMP stamped now would carry a β the athlete's answer may
 * still contradict: onboarding is in progress and either
 *   - no sex resolves (wizard answer, Strava prefill or HealthKit seed, read
 *     through the normaliser's own resolveBiologicalSex) and a question is
 *     still ahead, or
 *   - the mode is triathlon, cycling or HYROX and about-you, which shows any
 *     prefilled sex for confirmation, has not been left yet.
 *
 * Not pending after onboarding (s.biologicalSex is canonical), or once the
 * question is behind the user or never coming (Just-Track): the unanswered
 * value is then final, and an unknown sex means β 1.92 on both sides of the
 * conversion. 'prefer_not_to_say' is an answer, so it does not hold.
 */
export function isTrimpSexPending(s: TrimpSexGateSource): boolean {
  if (s.hasCompletedOnboarding === true) return false;
  const ob = s.onboarding;
  if (ob?.trackOnly === true) return false; // Just-Track skips about-you and schedule
  const step = ob?.currentStep;
  if (ob?.trainingMode && ABOUT_YOU_MODES.has(ob.trainingMode)
      && (!step || STEPS_AT_OR_BEFORE_ABOUT_YOU.has(step))) {
    return true;
  }
  if (resolveBiologicalSex(s) !== undefined) return false;
  if (!ob) return true; // fresh state before initWizard: the wizard and its question are ahead
  return !step || STEPS_AT_OR_BEFORE_SEX_QUESTION.has(step);
}

const _held = new Map<string, () => Promise<unknown>>();

/**
 * Register a sync to run once the gate opens. Call only after
 * isTrimpSexPending() returned true. Keyed: a second hold under the same key
 * replaces the first, so the sync runs once.
 */
export function holdUntilTrimpSexKnown(key: string, resume: () => Promise<unknown>): void {
  if (!_held.has(key)) {
    console.log(`[TrimpSexGate] ${key} held until the athlete's sex is final (it sets the iTRIMP β)`);
  }
  _held.set(key, resume);
}

/**
 * Run every held sync if the gate is now open. Safe to call often: it does
 * nothing while the sex is still pending or nothing is held. Each run starts
 * on a microtask (after the caller's own state writes) and is registered with
 * trackStartupTask, so awaitStartupSyncs callers (the review step, the
 * triathlon past-race scan) wait for it instead of reading the activity table
 * mid-write. Resolves when the released runs settle, with how many were
 * released.
 */
export function releaseHeldTrimpSyncs(s: TrimpSexGateSource): Promise<number> {
  if (_held.size === 0 || isTrimpSexPending(s)) return Promise.resolve(0);
  const runs = [..._held.entries()];
  _held.clear();
  const settled = runs.map(([key, resume]) => {
    console.log(`[TrimpSexGate] sex is final, running held ${key}`);
    return trackStartupTask(
      Promise.resolve()
        .then(resume)
        .catch((err) => { console.warn(`[TrimpSexGate] held ${key} failed`, err); }),
    );
  });
  return Promise.all(settled).then(() => runs.length);
}

/** Keys currently held. Test and diagnostics seam. */
export function heldTrimpSyncKeys(): string[] {
  return [..._held.keys()];
}

/** Drop everything held. Test seam only. */
export function _resetHeldTrimpSyncsForTest(): void {
  _held.clear();
}
