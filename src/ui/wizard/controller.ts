import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderStep } from './renderer';

/** Consolidated wizard (re-ordered 2026-04-27): welcome → connect-data → goals →
 *  race-target → schedule → review → initializing → plan-preview-v2 → main-view.
 *
 *  Connect first so backfill + physio sync can run in the background while the
 *  user picks goal/volume; the merged "Athlete Profile" review then displays
 *  what we know once the data has settled (with a wait spinner if not).
 *
 *  `manual-entry` is a branch off connect-data when the user skips Strava.
 *  `triathlon-setup` is a branch off goals, replacing race-target + schedule
 *  for triathlon users.
 *  `runner-type` was merged into `review`. No longer a separate step. */
const STEP_ORDER: OnboardingStep[] = [
  'welcome',
  'goals',
  'connect-data',
  'about-you',
  'race-target',
  'schedule',
  'commute',
  'review',
  'initializing',
  'plan-preview-v2',
  'main-view',
];

/**
 * Initialize the onboarding wizard
 */
export function initWizard(): void {
  const s = getState();

  if (!s.onboarding) {
    updateState({
      onboarding: { ...defaultOnboardingState },
      hasCompletedOnboarding: false,
    });
    saveState();
  }

  // After soft reset: skip welcome if name already exists. The returning user
  // lands on goals (the post-restructure entry point. Connect-data now sits
  // after goals so triathletes see Strava+watch connect once they've picked
  // their mode).
  if (s.onboarding?.name && s.onboarding.currentStep === 'welcome') {
    updateState({
      onboarding: { ...s.onboarding, currentStep: 'goals' },
    });
    saveState();
  }

  // Migration: 'connect-strava' was renamed to 'connect-data' (2026-05-28) when
  // the step became a watch-first router. Persisted state from before the rename
  // points at the legacy id. Silently bump it to the new id so returning users
  // land on the right page rather than getting kicked back to 'goals' by the
  // generic catch-all below.
  const beforeMigration = getState().onboarding;
  if (beforeMigration && (beforeMigration.currentStep as string) === 'connect-strava') {
    updateState({
      onboarding: { ...beforeMigration, currentStep: 'connect-data' },
    });
    saveState();
  }

  // Migration: if persisted currentStep is no longer in the wizard (legacy step
  // removed during cleanup, e.g. 'runner-type' after the merge into review),
  // bump the user to a sensible re-entry point. Preserves name/PBs.
  const current = getState().onboarding;
  if (current && !STEP_ORDER.includes(current.currentStep) && current.currentStep !== 'manual-entry' && current.currentStep !== 'triathlon-setup' && current.currentStep !== 'tri-past-race' && current.currentStep !== 'tri-workout-preview' && current.currentStep !== 'tri-plan-forecast' && current.currentStep !== 'cycling-setup' && current.currentStep !== 'hyrox-setup' && current.currentStep !== 'hyrox-workout-preview' && current.currentStep !== 'workout-preview' && current.currentStep !== 'about-you') {
    updateState({
      onboarding: { ...current, currentStep: current.name ? 'goals' : 'welcome' },
    });
    saveState();
  }

  renderCurrentStep();
}

/**
 * Get current onboarding state
 */
export function getOnboardingState(): OnboardingState | undefined {
  return getState().onboarding;
}

/**
 * Update onboarding state with partial values
 */
export function updateOnboarding(updates: Partial<OnboardingState>): void {
  const s = getState();
  if (!s.onboarding) return;

  updateState({
    onboarding: {
      ...s.onboarding,
      ...updates,
    },
  });
  saveState();
}

/**
 * Navigate to a specific step
 */
export function goToStep(step: OnboardingStep): void {
  const s = getState();
  if (!s.onboarding) return;

  updateState({
    onboarding: {
      ...s.onboarding,
      currentStep: step,
    },
  });
  saveState();
  renderCurrentStep();
}

/**
 * Advance to the next step
 */
export function nextStep(): void {
  const s = getState();
  if (!s.onboarding) return;

  // Branch: triathlon users route from goals → triathlon-setup → review →
  // initializing → main-view. The consolidated triathlon-setup step replaces
  // race-target + schedule for this flow (§18.9). Review is shared so tri
  // athletes still see the unified Athlete Profile reveal.
  if (s.onboarding.trainingMode === 'triathlon') {
    if (s.onboarding.currentStep === 'goals') {
      goToStep('connect-data');
      return;
    }
    if (s.onboarding.currentStep === 'connect-data') {
      goToStep('about-you');
      return;
    }
    if (s.onboarding.currentStep === 'about-you') {
      goToStep('triathlon-setup');
      return;
    }
    if (s.onboarding.currentStep === 'triathlon-setup') {
      goToStep('tri-past-race');
      return;
    }
    if (s.onboarding.currentStep === 'tri-past-race') {
      goToStep('tri-workout-preview');
      return;
    }
    if (s.onboarding.currentStep === 'tri-workout-preview') {
      goToStep('commute');
      return;
    }
    if (s.onboarding.currentStep === 'commute') {
      goToStep('review');
      return;
    }
    if (s.onboarding.currentStep === 'initializing') {
      // The plan + prediction now exist. Show the interactive forecast reveal
      // (goal time + per-discipline session lever) before the main view,
      // mirroring running's initializing → plan-preview-v2.
      goToStep('tri-plan-forecast');
      return;
    }
    if (s.onboarding.currentStep === 'tri-plan-forecast') {
      completeOnboarding();
      goToStep('main-view');
      return;
    }
  }

  // Branch: HYROX users route from goals → connect-data → about-you →
  // hyrox-setup → hyrox-workout-preview → initializing → main-view.
  // The previous review step was killed because for HYROX users it duplicated
  // the setup screen; the workout preview now shows the prescribed session
  // library so users see plan depth before committing.
  if (s.onboarding.trainingMode === 'hyrox') {
    if (s.onboarding.currentStep === 'goals') {
      goToStep('connect-data');
      return;
    }
    if (s.onboarding.currentStep === 'connect-data') {
      goToStep('about-you');
      return;
    }
    if (s.onboarding.currentStep === 'about-you') {
      goToStep('hyrox-setup');
      return;
    }
    if (s.onboarding.currentStep === 'hyrox-setup') {
      goToStep('hyrox-workout-preview');
      return;
    }
    if (s.onboarding.currentStep === 'hyrox-workout-preview') {
      // HYROX adds a commute capture step between the workout preview and
      // initialising. Commute runs are appended on top of the prescribed
      // HYROX sessions (see plan_engine.hyrox.ts).
      goToStep('commute');
      return;
    }
    if (s.onboarding.currentStep === 'commute') {
      // Skip the recap review step for HYROX. The workout-preview was the
      // final reveal; commute is the only thing between it and plan generation.
      goToStep('initializing');
      return;
    }
    if (s.onboarding.currentStep === 'initializing') {
      completeOnboarding();
      goToStep('main-view');
      return;
    }
  }

  // Branch: cycling users route from goals → connect-data → about-you →
  // cycling-setup → workout-preview → review → initializing → main-view.
  // workout-preview is the "research showcase" step that lists the bike
  // workout library before plan generation.
  if (s.onboarding.trainingMode === 'cycling') {
    if (s.onboarding.currentStep === 'goals') {
      goToStep('connect-data');
      return;
    }
    if (s.onboarding.currentStep === 'connect-data') {
      goToStep('about-you');
      return;
    }
    if (s.onboarding.currentStep === 'about-you') {
      goToStep('cycling-setup');
      return;
    }
    if (s.onboarding.currentStep === 'cycling-setup') {
      goToStep('workout-preview');
      return;
    }
    if (s.onboarding.currentStep === 'workout-preview') {
      goToStep('review');
      return;
    }
    if (s.onboarding.currentStep === 'initializing') {
      completeOnboarding();
      goToStep('main-view');
      return;
    }
  }

  // Branch: if leaving connect-data with skippedStrava, route to manual-entry
  // (where the user enters PBs by hand). Otherwise the linear order takes us to
  // 'goals' next.
  if (s.onboarding.currentStep === 'connect-data' && s.onboarding.skippedStrava) {
    goToStep('manual-entry');
    return;
  }

  // Branch: running connect-data with a data source connected (not skipped). The
  // About-you step was removed from the running flow (age is now captured on the
  // schedule step, sex pre-fills from Strava), so go straight to race-target.
  // Tri/cycling/HYROX handled their own connect-data routing in the blocks above.
  if (s.onboarding.currentStep === 'connect-data') {
    goToStep('race-target');
    return;
  }

  // Branch: manual-entry (running, no data source) rejoins at race-target. About-you
  // was removed for running; age + sex are captured on the schedule step instead.
  if (s.onboarding.currentStep === 'manual-entry') {
    goToStep('race-target');
    return;
  }

  // Branch: about-you for running mode (no specific trainingMode or 'running' /
  // 'fitness') routes to race-target. Other modes are handled by their
  // mode-specific blocks above.
  if (s.onboarding.currentStep === 'about-you') {
    goToStep('race-target');
    return;
  }

  // Branch: race-target → schedule for everyone except track-only. Track-only
  // users skip schedule (no plan to size) but still capture commute (tag + load
  // are mode-agnostic and apply even without a plan) then see the review/profile
  // reveal so they get the same "this is who you are" moment.
  if (s.onboarding.currentStep === 'race-target' && s.onboarding.trackOnly) {
    goToStep('commute');
    return;
  }

  // Branch: running users (no specific trainingMode or mode === 'running') go
  // schedule → workout-preview → commute → review. Commute slots in here so the
  // user has just seen their planned sessions and is in the headspace to
  // consider what they already run outside the plan. Cycling handles its own
  // workout-preview → review inside its block above (no run leg, no commute).
  const isRunningMode = !s.onboarding.trainingMode || s.onboarding.trainingMode === 'running';
  if (s.onboarding.currentStep === 'schedule' && isRunningMode && !s.onboarding.trackOnly) {
    // Running: the workout demonstration ("what your plan looks like") now comes AFTER
    // the plan (plan-preview-v2 → workout-preview), so schedule goes straight to review.
    goToStep('review');
    return;
  }
  if (s.onboarding.currentStep === 'workout-preview') {
    // Running: workout-preview is now the post-plan demonstration and the final step.
    // Its CTA completes onboarding directly; this is a safe fallback. (Cycling handles
    // its own pre-plan workout-preview → review inside its block above.)
    completeOnboarding();
    goToStep('main-view');
    return;
  }
  if (s.onboarding.currentStep === 'commute') {
    goToStep('review');
    return;
  }

  // Branch: review → initializing. Initialising runs plan generation; track-only
  // short-circuits inside initializeSimulator(). Linear order would also send us
  // to 'initializing' next, but making it explicit keeps intent visible.
  if (s.onboarding.currentStep === 'review') {
    goToStep('initializing');
    return;
  }

  // Branch: after initialization in Just-Track mode, skip plan-preview-v2 and
  // land on main-view. Plan-preview only makes sense when a plan was generated.
  if (s.onboarding.currentStep === 'initializing' && s.onboarding.trackOnly) {
    completeOnboarding();
    goToStep('main-view');
    return;
  }

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  let nextIdx = currentIdx + 1;

  // Just-Track users: skip any remaining plan-dependent screens (plan-preview-v2).
  // Belt-and-braces on top of the explicit branches above.
  if (s.onboarding.trackOnly) {
    while (nextIdx < STEP_ORDER.length && STEP_ORDER[nextIdx] === 'plan-preview-v2') {
      nextIdx++;
    }
  }

  if (nextIdx < STEP_ORDER.length) {
    const completedSteps = s.onboarding.completedSteps.includes(s.onboarding.currentStep)
      ? s.onboarding.completedSteps
      : [...s.onboarding.completedSteps, s.onboarding.currentStep];

    updateState({
      onboarding: {
        ...s.onboarding,
        currentStep: STEP_ORDER[nextIdx],
        completedSteps,
      },
    });
    saveState();
    renderCurrentStep();
  }
}

/**
 * Go back to the previous step
 */
export function previousStep(): void {
  const s = getState();
  if (!s.onboarding) return;

  // Branch: triathlon-setup back → about-you (its prior step).
  if (s.onboarding.currentStep === 'triathlon-setup') {
    goToStep('about-you');
    return;
  }

  // Branch: tri-past-race back → triathlon-setup.
  if (s.onboarding.currentStep === 'tri-past-race') {
    goToStep('triathlon-setup');
    return;
  }

  // Branch: tri-workout-preview back → tri-past-race.
  if (s.onboarding.currentStep === 'tri-workout-preview') {
    goToStep('tri-past-race');
    return;
  }

  // Branch: tri-plan-forecast back → review. The plan is regenerated on the
  // forward pass through initializing, so returning to review (then forward)
  // rebuilds and lands back on the forecast cleanly.
  if (s.onboarding.currentStep === 'tri-plan-forecast') {
    goToStep('review');
    return;
  }

  // Branch: hyrox-setup back → about-you.
  if (s.onboarding.currentStep === 'hyrox-setup') {
    goToStep('about-you');
    return;
  }

  // Branch: hyrox-workout-preview back → hyrox-setup.
  if (s.onboarding.currentStep === 'hyrox-workout-preview') {
    goToStep('hyrox-setup');
    return;
  }

  // Branch: cycling-setup back → about-you (the previous step in cycling flow).
  if (s.onboarding.currentStep === 'cycling-setup') {
    goToStep('about-you');
    return;
  }

  // Branch: about-you back → connect-data (covers all modes; manual-entry
  // detour is handled by its own back branch below).
  if (s.onboarding.currentStep === 'about-you') {
    goToStep('connect-data');
    return;
  }

  // Branch: workout-preview back. Cycling's is pre-plan (→ cycling-setup). Running's
  // is now the post-plan demonstration, so back returns to the plan reveal.
  if (s.onboarding.currentStep === 'workout-preview') {
    const isRunning = !s.onboarding.trainingMode || s.onboarding.trainingMode === 'running';
    goToStep(isRunning ? 'plan-preview-v2' : 'cycling-setup');
    return;
  }

  // Branch: commute back → the preceding step. Mode-specific because each mode
  // routes through a different screen before commute. Track-only has no
  // workout-preview, so it comes straight from race-target.
  if (s.onboarding.currentStep === 'commute') {
    if (s.onboarding.trainingMode === 'triathlon') {
      goToStep('tri-workout-preview');
    } else if (s.onboarding.trainingMode === 'hyrox') {
      goToStep('hyrox-workout-preview');
    } else if (s.onboarding.trackOnly) {
      goToStep('race-target');
    } else {
      goToStep('workout-preview');
    }
    return;
  }

  // Branch: manual-entry back → connect-data. The user landed here by tapping
  // "Enter manually" on the connect step; clear skippedStrava so they can try
  // OAuth again if they changed their mind.
  if (s.onboarding.currentStep === 'manual-entry') {
    updateState({
      onboarding: { ...s.onboarding, skippedStrava: false, currentStep: 'connect-data' },
    });
    saveState();
    renderCurrentStep();
    return;
  }

  // Branch: review back depends on mode. Triathlon and running both pass
  // through commute before review now, so review-back lands on commute.
  // Cycling has no run leg (skips commute) → workout-preview. Track-only has
  // no schedule/commute step → race-target. HYROX has no review step.
  if (s.onboarding.currentStep === 'review') {
    if (s.onboarding.trainingMode === 'triathlon') {
      goToStep('commute');
    } else if (s.onboarding.trainingMode === 'hyrox') {
      goToStep('hyrox-setup');
    } else if (s.onboarding.trainingMode === 'cycling') {
      goToStep('workout-preview');
    } else if (s.onboarding.trackOnly) {
      // Track-only: race-target → commute → review.
      goToStep('commute');
    } else {
      // Running mode (default): workout-preview moved to after the plan, so review
      // now comes straight from the schedule step.
      goToStep('schedule');
    }
    return;
  }

  // Branch: race-target back → goals (the immediately-preceding step in the new
  // linear order).
  if (s.onboarding.currentStep === 'race-target') {
    goToStep('goals');
    return;
  }

  // Branch: goals back → welcome (immediately-preceding step in the new
  // post-restructure order. Connect-data now sits after goals).
  if (s.onboarding.currentStep === 'goals') {
    goToStep('welcome');
    return;
  }

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  if (currentIdx <= 0) return;

  let prevIdx = currentIdx - 1;

  // Skip 'initializing' when going back. Silent auto-advance step.
  while (prevIdx > 0 && STEP_ORDER[prevIdx] === 'initializing') {
    prevIdx--;
  }

  if (prevIdx >= 0) {
    updateState({
      onboarding: {
        ...s.onboarding,
        currentStep: STEP_ORDER[prevIdx],
      },
    });
    saveState();
    renderCurrentStep();
  }
}

/**
 * Mark onboarding as complete and transition to main view
 */
export function completeOnboarding(): void {
  const s = getState();
  if (!s.onboarding) return;

  const trialExpiry = new Date();
  trialExpiry.setDate(trialExpiry.getDate() + 21);

  updateState({
    hasCompletedOnboarding: true,
    trialExpiry: trialExpiry.toISOString(),
    onboarding: {
      ...s.onboarding,
      currentStep: 'main-view',
      completedSteps: [...s.onboarding.completedSteps, s.onboarding.currentStep],
    },
  });
  saveState();
}

/**
 * Upgrade from Just-Track mode: relaunch the wizard at the training-goal step
 * so the user walks goals → race/target → schedule → plan-preview and a plan
 * is generated. Clears `trackOnly` on both the onboarding record and global
 * state; preserves name, PBs, physiology, and Strava-derived fitness baselines
 * (ctlBaseline / historicWeeklyTSS / athleteTier).
 *
 * Wipes `s.wks` (skeleton tracking weeks with no planned workouts) so the
 * initializing step's mid-plan guard (`wks.length > 0 → skip plan gen`)
 * doesn't short-circuit the upgrade. Any activities previously matched into
 * these weeks' `garminActuals` re-sync from `garmin_activities` on the next
 * poll. Server-side history is the source of truth.
 */
export function upgradeFromTrackOnly(): void {
  const s = getState();
  if (!s.onboarding) return;

  // Flip onboarding mode. Do NOT wipe wks/w/tw here. InitializeSimulator
  // replaces them when the wizard completes, and wiping early destroys all
  // historical stats (activity matches, CTL history, VDOT chart data).
  updateState({
    hasCompletedOnboarding: false,
    trackOnly: false,
    onboarding: {
      ...s.onboarding,
      trackOnly: false,
      trainingFocus: s.onboarding.trainingFocus === 'track' ? null : s.onboarding.trainingFocus,
      currentStep: 'goals',
    },
  });
  saveState();
  renderCurrentStep();
}

/**
 * Downgrade from a generated plan to Just-Track mode. Preserves activity
 * history, CTL, PBs, physiology, and Strava connection. Just flips the plan
 * off. Users typically reach this after race day, end of a continuous block,
 * or deliberately via Account → Advanced.
 *
 * The initializing step detects the mode change (`!!onboarding.trackOnly !==
 * !!s.trackOnly`) and re-runs `initializeSimulator`, which takes the trackOnly
 * branch and rewrites `s.wks` as the rolling one-week bucket. Accumulated
 * garminActuals for the current week survive; prior planned weeks are dropped
 * from local state but remain in server-side `garmin_activities`.
 */
export function downgradeToTrackOnly(): void {
  const s = getState();
  if (!s.onboarding) return;
  updateState({
    hasCompletedOnboarding: false,
    onboarding: {
      ...s.onboarding,
      trackOnly: true,
      trainingFocus: 'track',
      continuousMode: true,
      trainingForEvent: null,
      raceDistance: null,
      selectedRace: null,
      customRaceDate: null,
      currentStep: 'initializing',
    },
  });
  saveState();
  renderCurrentStep();
}

/**
 * Reset onboarding to start fresh
 */
export function resetOnboarding(): void {
  updateState({
    onboarding: { ...defaultOnboardingState },
    hasCompletedOnboarding: false,
  });
  saveState();
  renderCurrentStep();
}

/**
 * Get the current step index (1-based for display)
 */
export function getCurrentStepNumber(): number {
  const s = getState();
  if (!s.onboarding) return 1;
  return STEP_ORDER.indexOf(s.onboarding.currentStep) + 1;
}

/**
 * Get total number of steps (excluding main-view)
 */
export function getTotalSteps(): number {
  return STEP_ORDER.length - 1;
}

/**
 * Check if we can go back
 */
export function canGoBack(): boolean {
  const s = getState();
  if (!s.onboarding) return false;
  return STEP_ORDER.indexOf(s.onboarding.currentStep) > 0;
}

/**
 * Render the current step
 */
function renderCurrentStep(): void {
  const s = getState();
  if (!s.onboarding) return;
  renderStep(s.onboarding.currentStep, s.onboarding);
}

// Expose functions globally for onclick handlers
declare global {
  interface Window {
    wizardNext: typeof nextStep;
    wizardPrev: typeof previousStep;
    wizardGoTo: typeof goToStep;
  }
}

if (typeof window !== 'undefined') {
  window.wizardNext = nextStep;
  window.wizardPrev = previousStep;
  window.wizardGoTo = goToStep;
}
