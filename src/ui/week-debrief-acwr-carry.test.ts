// @vitest-environment jsdom
/**
 * The week debrief's Ease back / Keep ramping toggle opens on the choice next()
 * would commit (ISSUE-295 episode memory).
 *
 * Before: the debrief previews next week with the live ACWR status, so the toggle
 * shows at every high-ACWR rollover. It always opened on Ease back and Accept
 * stamped 'ease', which next() prefers over the carried episode choice. A user who
 * chose Keep ramping last week, on a consecutive high week below the very-high
 * ratio and the re-prompt streak, had that choice silently reverted by Continue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('./renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./renderer')>()),
  render: vi.fn(),
  log: vi.fn(),
}));
vi.mock('@/ui/main-view', () => ({ renderMainView: vi.fn() }));

// A high-ACWR week: ratio above the safe range, below the very-high escalation.
const acwr = vi.hoisted(() => ({ ratio: 1.45 }));
vi.mock('@/calculations/fitness-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/fitness-model')>();
  return {
    ...actual,
    computeACWR: (...args: Parameters<typeof actual.computeACWR>) => ({
      ...actual.computeACWR(...args), status: 'high', ratio: acwr.ratio, ctl: 150, safeUpper: 1.3,
    }),
  };
});

import { showWeekDebrief, debriefAcwrInitialChoice } from './week-debrief';
import { resolveWeekWorkouts } from './week-resolve';
import { VERY_HIGH_ACWR } from '@/calculations/acwr-ease-back';
import { setState, resetState, getDefaultState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types';

/** Week 3 just finished. Week 3 was itself a high-ACWR week where the user chose Keep ramping. */
function state(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    planStartDate: '2026-03-02',
    w: 3, tw: 18, rw: 5, rd: 'half', typ: 'balanced', v: 48, gs: 0,
    pac: { e: 330, t: 275, i: 250, m: 300, r: 235 },
    signalBBaseline: 300,
    ctlBaseline: 300,
    wks: [1, 2, 3, 4, 5].map(w => ({
      w, ph: 'build', rated: {}, skip: [], workoutMods: [], garminActuals: {}, adhocWorkouts: [],
      garminMatched: {}, garminPending: [], unspentLoadItems: [],
      ...(w === 3 ? { scheduledAcwrStatus: 'high', acwrChoice: 'keep' } : {}),
    })),
  } as unknown as SimulatorState;
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  resetState();
  document.body.innerHTML = '';
  acwr.ratio = 1.45;
});
afterEach(() => { vi.useRealTimers(); });

describe('debrief ACWR toggle opens on the carried choice', () => {
  it('a prior Keep ramping on a consecutive high week below the very-high ratio opens on Keep ramping', () => {
    setState(state());
    expect(debriefAcwrInitialChoice(getMutableState(), 3, 'complete', 1.45)).toEqual({ choice: 'keep', carried: true });
    // Very high forces the re-prompt: the recommended pane.
    expect(debriefAcwrInitialChoice(getMutableState(), 3, 'complete', VERY_HIGH_ACWR)).toEqual({ choice: 'ease', carried: false });
    // In review mode next() has run: its stamp on next week decides.
    getMutableState().wks[3].acwrChoice = 'keep';
    expect(debriefAcwrInitialChoice(getMutableState(), 3, 'review', 1.45)).toEqual({ choice: 'keep', carried: false });
  });

  it('Accept without a tap keeps Keep ramping through next()', async () => {
    setState(state());
    // Every week-3 session is done, so next() has nothing to gate on.
    const wk3 = getMutableState().wks[2];
    for (const w of resolveWeekWorkouts(getMutableState(), 3) as any[]) wk3.rated[w.id || w.n] = 5;

    vi.useFakeTimers();
    showWeekDebrief(3, 'complete');
    (document.getElementById('debrief-continue') as HTMLButtonElement).click();
    vi.advanceTimersByTime(20_000); // analysis animation, then the plan preview

    // The toggle is showing the alternative pane.
    expect(document.getElementById('plan-standard')?.style.display).toBe('block');
    expect(document.getElementById('plan-adjusted')?.style.display).toBe('none');

    (document.getElementById('debrief-accept') as HTMLButtonElement).click();
    vi.useRealTimers();
    await flush();

    const s = getMutableState();
    expect(s.w).toBe(4);
    expect(s.wks[3].scheduledAcwrStatus).toBe('high');
    expect(s.wks[3].acwrChoice).toBe('keep');
  });
});
