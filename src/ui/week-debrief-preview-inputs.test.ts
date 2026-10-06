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
import { generateWeekWorkouts } from '@/workouts/generator';
import { getDefaultState } from '@/state/store';
import { setState, resetState, getState } from '@/state/store';
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
