// @vitest-environment jsdom
/**
 * The week-debrief "next week" preview runs the plan engine with the inputs the
 * committed week gets (audit X12).
 *
 * Before: the preview called planWeekSessions without the user's excluded session
 * types, the hours cap, forced deload, easy pace or the ramp baseline/archetype
 * the generator reads from state, and in 'complete' mode it read an ACWR stamp
 * next() had not written yet (so it always previewed a 'safe' week).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
const acwr = vi.hoisted(() => ({ status: 'caution' as string }));
vi.mock('@/calculations/fitness-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/fitness-model')>();
  return {
    ...actual,
    computeACWR: (...args: Parameters<typeof actual.computeACWR>) => ({ ...actual.computeACWR(...args), status: acwr.status }),
  };
});

import { debriefPreviewPlanInputs } from './week-debrief';
import { planWeekSessions } from '@/workouts/plan_engine';
import { generateWeekWorkouts, initializeWeeks } from '@/workouts/generator';
import { isLongRun } from '@/workouts/long-run';
import { liveSharpeningLongRunCapMin } from '@/workouts/sharpening-block';
import { getDefaultState } from '@/state/store';
import { setState, resetState, getState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types';

function state(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    planStartDate: '2026-03-02',
    w: 3, tw: 18, rw: 5, rd: 'half', typ: 'balanced', v: 48, gs: 0, pac: { e: 330 },
    detectedWeeklyKm: 42,
    onboarding: { ...getDefaultState().onboarding, weeklyTrainingHours: 5, runningExcludedWorkouts: ['threshold'] } as any,
    wks: [1, 2, 3, 4].map(w => ({ w, ph: 'build', rated: {}, skip: [], workoutMods: [], ...(w === 4 ? { forceDeload: true } : {}) })),
  } as unknown as SimulatorState;
}

describe('debrief next-week preview inputs', () => {
  beforeEach(() => { resetState(); acwr.status = 'caution'; });

  it('carries every input the generator hands the plan engine for that week', () => {
    setState(state());
    const { baseCtx } = debriefPreviewPlanInputs(getState(), 3, 'complete');
    expect(baseCtx.excludedSlots).toEqual(['threshold']);
    expect(baseCtx.weeklyHoursTarget).toBe(5);
    expect(baseCtx.forceDeload).toBe(true);
    expect(baseCtx.easyPaceSecPerKm).toBe(330);
    expect(baseCtx.baselineKm).toBe(42);

    // The previewed sessions are the committed sessions (same engine inputs).
    const preview = planWeekSessions({ ...baseCtx, acwrStatus: 'safe' }).map(i => i.slot).sort();
    const committed = generateWeekWorkouts(
      'build', 5, 'half', 'balanced' as any, [], undefined, null, undefined, undefined, undefined, 330, 4, 18, 48, 0,
      undefined, 'safe', true, 5, ['threshold'],
    ).filter(w => w.t !== 'gym' && w.t !== 'cross').map(w => (w.longRun ? 'long' : w.t)).sort();
    expect(preview).not.toContain('threshold');
    expect(preview).toEqual(committed);
  });

  it("in 'complete' mode reads next week's ACWR status live; in 'review' mode an absent stamp means safe", () => {
    setState(state());
    expect(debriefPreviewPlanInputs(getState(), 3, 'complete').acwrStatus).toBe('caution');
    expect(debriefPreviewPlanInputs(getState(), 3, 'review').acwrStatus).toBe('safe');
    acwr.status = 'safe';
    expect(debriefPreviewPlanInputs(getState(), 3, 'complete').acwrStatus).toBe('safe');
  });
});

/**
 * Sharpening block: the end-of-week ('complete') debrief previews week s.w + 1
 * before s.w advances. Before: debriefPreviewPlanInputs passed
 * liveSharpeningLongRunCapMin(s, weekNum + 1), which returns undefined for any
 * week past s.w, so the preview listed the uncapped long run while the
 * committed week (generated once s.w advanced) applied the live cap. The two
 * differed exactly when the cap exists: a long run done short or skipped.
 */
describe('debrief next-week preview: sharpening block live long-run cap', () => {
  beforeEach(() => { resetState(); acwr.status = 'safe'; });

  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9).toISOString();
  function blockState(): SimulatorState {
    const tw = 7;
    return {
      ...getDefaultState(),
      eventType: 'running', continuousMode: false,
      planStartDate: '2026-09-07',
      w: 2, tw, rw: 4, rd: 'marathon', typ: 'Balanced', v: 45, gs: 0, pac: { e: 330 },
      detectedWeeklyKm: 40, wkm: 40,
      athleteArchetype: { archetype: 'consistent-runner' },
      onboarding: { ...getDefaultState().onboarding, experienceLevel: 'intermediate', weeklyTrainingHours: undefined, runningExcludedWorkouts: [] } as any,
      sharpenBlock: { v: 1, startLongMin: 100, startSource: 'history-30d', recentLongestMin: 100, noSignal: false, trainingWeeks: 7, builtISO: '2026-09-07' },
      // The 100-min run that set the start (Aug 20) leaves the window before week 3 (Sep 21).
      // Week 1's long run was cut to 12 km (66 min at 5:30/km); week 2 logged 10 km.
      onboardingRunHistory: [
        { startTime: at(2026, 8, 20), distKm: 18.2, durSec: 18.2 * 330, activityType: 'RUNNING' },
        { startTime: at(2026, 9, 12), distKm: 12, durSec: 12 * 330, activityType: 'RUNNING' },
        { startTime: at(2026, 9, 16), distKm: 10, durSec: 10 * 330, activityType: 'RUNNING' },
      ],
      wks: initializeWeeks(tw, { raceDistance: 'marathon' }),
    } as unknown as SimulatorState;
  }

  it("a short logged long run: the previewed long run is the committed long run", () => {
    setState(blockState());
    const { baseCtx } = debriefPreviewPlanInputs(getState(), 2, 'complete');
    expect(baseCtx.liveLongRunCapMin).toBe(Math.floor(66 * 1.07));
    const previewLong = planWeekSessions({ ...baseCtx, acwrStatus: 'safe' }).find(i => i.slot === 'long')?.totalMinutes;

    // Rollover: s.w advances and the generator builds week 3.
    getMutableState().w = 3;
    expect(liveSharpeningLongRunCapMin(getState() as any, 3)).toBe(baseCtx.liveLongRunCapMin);
    const committedLong = generateWeekWorkouts(
      getState().wks[2].ph, 4, 'marathon', 'Balanced' as any, [], undefined, null, undefined, 'intermediate',
      undefined, 330, 3, 7, 45, 0, undefined, 'safe',
    ).find(isLongRun)?.estimatedDurationMin;

    expect(previewLong).toBe(70);
    expect(previewLong).toBe(committedLong);
  });
});
