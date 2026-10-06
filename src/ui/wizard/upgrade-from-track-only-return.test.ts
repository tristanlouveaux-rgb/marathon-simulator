// @vitest-environment jsdom
/**
 * Backing out of "Create a training plan" keeps a Just-Track user in Just-Track.
 *
 * Account > Create a training plan calls upgradeFromTrackOnly, which reopens
 * the wizard at goals with the Just-Track bucket weeks still in state. The
 * wizard renders "Return to plan" on every step while weeks exist, and that
 * button sets hasCompletedOnboarding = true without building anything.
 *
 * Before the fix upgradeFromTrackOnly cleared the global s.trackOnly up front,
 * so backing out left a user with no plan running as a continuous running plan
 * built from defaults: resolveWeekWorkouts produced five sessions over the
 * bucket weeks, and the next synced run auto-completed one of those phantom
 * slots (W1-easy-0) instead of logging as an extra activity.
 *
 * Only the wizard's own record (onboarding.trackOnly) flips now. Every init
 * branch clears s.trackOnly when it builds a plan, and the initializing step
 * runs a full init when the two flags differ. The second block walks the
 * upgrade through the initializing step for running, HYROX and triathlon.
 *
 * The third block picks a mode on goals before backing out. goals writes
 * onboarding.trainingMode, which is read after onboarding ends: main-view
 * routed the Plan tab to the HYROX plan view (blank with no hyroxConfig) and
 * isCyclingOnlyMode turned cycling copy on across Just-Track surfaces. Return
 * to plan now restores the Just-Track onboarding record when no plan was built.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
  loadState: vi.fn(),
}));

// The Return button lands on Just-Track Home through a dynamic import; Home is
// not under test. main-view and the running plan view are real: the third
// block taps the Plan tab after backing out. The HYROX and triathlon plan views
// are spies, so a route to either shows up.
vi.mock('@/ui/home-view', () => ({ renderHomeView: vi.fn() }));
vi.mock('@/ui/hyrox/plan-view', () => ({ renderHyroxPlanView: vi.fn() }));
vi.mock('@/ui/triathlon/plan-view', () => ({ renderTriathlonPlanView: vi.fn() }));

// The real renderer draws goals (it carries the Return button) and the
// initializing step (it runs plan generation). The steps after initializing
// (plan previews, coach contract) are not under test and render nothing here.
vi.mock('./renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./renderer')>();
  return {
    ...actual,
    renderStep: vi.fn((step: string, state: unknown) => {
      if (step === 'goals' || step === 'initializing') {
        (actual.renderStep as (s: string, st: unknown) => void)(step, state);
      }
    }),
  };
});

import { getDefaultState, setState, getState, getMutableState } from '@/state/store';
import { getMondayOf } from '@/state/persistence';
import { initializeSimulator } from '@/state/initialization';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { Week } from '@/types';
import { upgradeFromTrackOnly, updateOnboarding, goToStep } from './controller';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { isTrimpSexPending } from '@/data/trimp-sex-gate';
import { isCyclingOnlyMode } from '@/calculations/cycling-mode';
import { renderHomeView } from '@/ui/home-view';
import { renderMainView } from '@/ui/main-view';
import { renderHyroxPlanView } from '@/ui/hyrox/plan-view';
import { renderTriathlonPlanView } from '@/ui/triathlon/plan-view';

const DAY_MS = 24 * 60 * 60 * 1000;

const JUST_TRACK_ONBOARDING: OnboardingState = {
  ...defaultOnboardingState,
  name: 'Sample',
  age: 34,
  biologicalSex: 'male',
  trainingMode: 'fitness',
  trainingFocus: 'track',
  trackOnly: true,
  continuousMode: true,
  trainingForEvent: null,
  raceDistance: null,
  selectedRace: null,
  customRaceDate: null,
  currentStep: 'main-view',
};

/** An empty Just-Track bucket week, the shape initializeSimulator writes. */
function bucketWeek(w: number): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

/**
 * A Just-Track user one week in: built through the real Just-Track init, then
 * the calendar moved on a week (advanceWeekToToday extends one bucket at a
 * time), so week 1 is a past week and week 2 is current.
 */
function justTrackUserOneWeekIn(): string {
  const s0 = getDefaultState();
  s0.hasCompletedOnboarding = false;
  setState(s0);
  const res = initializeSimulator({ ...JUST_TRACK_ONBOARDING });
  expect(res.success).toBe(true);

  const s = getMutableState();
  expect(s.trackOnly).toBe(true);
  const week1Monday = new Date(getMondayOf(new Date()).getTime() - 7 * DAY_MS);
  const week1 = week1Monday.toISOString().slice(0, 10);
  s.planStartDate = week1;
  s.planCreatedAt = week1; // a Just-Track user since week 1: every day of it counts
  s.wks = [bucketWeek(1), bucketWeek(2)];
  s.w = 2;
  s.tw = 2;
  s.hasCompletedOnboarding = true;
  s.onboarding = { ...JUST_TRACK_ONBOARDING };
  return week1;
}

/** A synced Strava run at 07:00 on `dayOffset` days after `mondayIso`. */
function stravaRun(mondayIso: string, dayOffset: number, km: number, min: number): GarminActivityRow {
  const start = new Date(Date.parse(`${mondayIso}T07:00:00.000Z`) + dayOffset * DAY_MS).toISOString();
  return {
    garmin_id: 'strava-777', start_time: start, duration_sec: min * 60, activity_type: 'RUNNING',
    distance_m: km * 1000, avg_pace_sec_km: Math.round((min * 60) / km), avg_hr: null, max_hr: null,
    calories: null, aerobic_effect: null, anaerobic_effect: null,
  };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(renderHomeView).mockClear();
  vi.mocked(renderHyroxPlanView).mockClear();
  vi.mocked(renderTriathlonPlanView).mockClear();
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('Create a training plan, then Return to plan, keeps Just-Track', () => {
  it('upgradeFromTrackOnly flips only the wizard record; s.trackOnly stays until a plan is built', () => {
    justTrackUserOneWeekIn();

    upgradeFromTrackOnly();

    const s = getState();
    expect(s.onboarding?.trackOnly).toBe(false);
    expect(s.onboarding?.currentStep).toBe('goals');
    expect(s.onboarding?.trainingFocus).toBeNull();
    expect(s.hasCompletedOnboarding).toBe(false);
    expect(s.trackOnly).toBe(true);
    // The sex gate reads the wizard record, so it holds as for any plan flow
    // at goals (no answer is final until the wizard asks again).
    expect(isTrimpSexPending({ ...s, biologicalSex: undefined, onboarding: { ...s.onboarding!, biologicalSex: undefined } })).toBe(true);
  });

  it('Return to plan lands back in Just-Track: no phantom running plan, a synced run logs as an extra activity', async () => {
    const week1 = justTrackUserOneWeekIn();

    upgradeFromTrackOnly();
    const btn = document.getElementById('wizard-return-btn');
    expect(btn).not.toBeNull();
    btn!.click();
    await settle();

    const s = getMutableState();
    expect(s.hasCompletedOnboarding).toBe(true);
    expect(s.trackOnly).toBe(true);

    // A 7 km easy run on the Monday of week 1 (a past week) syncs. Running as
    // a plan, the defaults put W1-easy-0 (7 km) on that Monday and the run
    // bound to it.
    matchAndAutoComplete([stravaRun(week1, 0, 7, 42)]);

    const wk1 = getMutableState().wks[0];
    expect(wk1.garminMatched?.['strava-777']).toBe('garmin-strava-777');
    expect(wk1.adhocWorkouts?.map(w => w.id)).toEqual(['garmin-strava-777']);
    expect(Object.keys(wk1.garminActuals ?? {}).filter(k => k.startsWith('W1-'))).toEqual([]);
    expect(Object.keys(wk1.rated ?? {}).filter(k => k.startsWith('W1-'))).toEqual([]);
  });
});

/** What each mode's wizard has collected by the time it reaches initializing. */
const PLAN_ONBOARDING: Record<string, Partial<OnboardingState>> = {
  'running, race': {
    trainingMode: 'running', trainingForEvent: true, raceDistance: 'half',
    planDurationWeeks: 16, runsPerWeek: 4, pbs: { k5: 1320 },
  },
  // No event, endurance focus: s.rd stays 'half' and s.continuousMode stays
  // true, so with both trackOnly flags false no settings-change check fired
  // and the initializing step kept the bucket weeks.
  'running, no event': {
    trainingMode: 'running', trainingForEvent: false, trainingFocus: 'endurance',
    runsPerWeek: 4, pbs: { k5: 1320 },
  },
  HYROX: {
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8,
  },
  triathlon: {
    trainingMode: 'triathlon', triDistance: '70.3', triTimeAvailableHoursPerWeek: 8,
  },
};

describe('Create a training plan, completed, builds the plan and leaves Just-Track', () => {
  for (const [label, settings] of Object.entries(PLAN_ONBOARDING)) {
    it(`${label}: the initializing step builds the plan and clears s.trackOnly`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        justTrackUserOneWeekIn();
        upgradeFromTrackOnly();
        updateOnboarding(settings);
        goToStep('initializing');
        await vi.advanceTimersByTimeAsync(10_000);

        const s = getState();
        expect(document.getElementById('init-title')?.textContent).not.toBe('Initialization failed');
        expect(s.trackOnly).toBe(false);
        expect(s.wks.length).toBeGreaterThan(2); // the plan, not the two bucket weeks
        if (settings.trainingMode === 'hyrox') {
          expect(s.eventType).toBe('hyrox');
          expect(s.hyroxConfig).toBeDefined();
        } else if (settings.trainingMode === 'triathlon') {
          expect(s.eventType).toBe('triathlon');
          expect(s.triConfig).toBeDefined();
        } else {
          expect(s.eventType).toBe('running');
          expect(s.continuousMode).toBe(settings.trainingForEvent === false);
        }
        expect(s.onboarding?.currentStep).not.toBe('initializing'); // advanced past it
      } finally {
        vi.useRealTimers();
      }
    });
  }
});

/** What the goals cycling tile writes (goals.ts). The tile is hidden from the
 *  picker (HIDDEN_MODES) but its handler and every cycling path downstream
 *  stay live, so the record is written directly. */
const CYCLING_PICK: Partial<OnboardingState> = {
  trainingMode: 'cycling', trackOnly: false, continuousMode: false, trainingForEvent: true,
  raceDistance: null, trainingFocus: null, selectedRace: null, customRaceDate: null,
};

describe('Create a training plan, pick a mode, then Return to plan, keeps Just-Track', () => {
  for (const mode of ['hyrox', 'cycling', 'triathlon', 'running'] as const) {
    it(`${mode} picked on goals: Return to plan restores the Just-Track record and the Plan tab shows the Just-Track log`, async () => {
      justTrackUserOneWeekIn();
      upgradeFromTrackOnly();

      if (mode === 'cycling') {
        updateOnboarding(CYCLING_PICK);
      } else {
        // The real goals tile: it writes the mode's onboarding fields and moves on.
        const tile = document.querySelector<HTMLElement>(`.mode-tile[data-mode="${mode}"]`);
        expect(tile).not.toBeNull();
        tile!.click();
      }
      expect(getState().onboarding?.trainingMode).toBe(mode);
      expect(getState().onboarding?.trackOnly).toBe(false);

      document.getElementById('wizard-return-btn')!.click();
      await settle();

      const s = getState();
      expect(s.hasCompletedOnboarding).toBe(true);
      expect(s.trackOnly).toBe(true);
      expect(renderHomeView).toHaveBeenCalledTimes(1);

      // Plan tab: the running plan view's Just-Track branch, not a mode view.
      // Before the fix a HYROX pick routed here to the HYROX plan view, which
      // renders nothing without a hyroxConfig.
      renderMainView();
      const modeViewCalls = () =>
        vi.mocked(renderHyroxPlanView).mock.calls.length + vi.mocked(renderTriathlonPlanView).mock.calls.length;
      await vi.waitFor(() => {
        expect(modeViewCalls() > 0 || document.getElementById('track-generate-session') !== null).toBe(true);
      });
      expect(renderHyroxPlanView).not.toHaveBeenCalled();
      expect(renderTriathlonPlanView).not.toHaveBeenCalled();
      expect(document.getElementById('track-generate-session')).not.toBeNull();

      // Before the fix a cycling pick left cycling copy and logic on across
      // Just-Track surfaces (account volume label, VO2max card, injury risk).
      expect(isCyclingOnlyMode(s)).toBe(false);

      // The record the goals Just-Track tile writes.
      expect(s.onboarding).toMatchObject({
        trainingMode: 'fitness',
        trainingFocus: 'track',
        trackOnly: true,
        continuousMode: true,
        trainingForEvent: null,
        raceDistance: null,
        selectedRace: null,
        customRaceDate: null,
      });
    });
  }

  it('a user with a plan keeps their onboarding record on Return to plan', async () => {
    justTrackUserOneWeekIn();
    const s0 = getMutableState();
    s0.trackOnly = false; // a plan exists
    s0.hasCompletedOnboarding = false;
    s0.onboarding = { ...s0.onboarding!, trainingMode: 'hyrox', trackOnly: false, trainingFocus: null, currentStep: 'goals' };
    goToStep('goals');

    document.getElementById('wizard-return-btn')!.click();
    await settle();

    const s = getState();
    expect(s.hasCompletedOnboarding).toBe(true);
    expect(s.onboarding?.trainingMode).toBe('hyrox');
    expect(s.onboarding?.trackOnly).toBe(false);
    expect(renderHomeView).not.toHaveBeenCalled();
  });
});
