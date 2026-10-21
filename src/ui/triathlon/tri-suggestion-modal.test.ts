// @vitest-environment jsdom
/**
 * Every answer in the tri / cycling suggestion modal is remembered for the week
 * (notify-once). Regression (review of a1): once the detectors read the current
 * week, the overload modal re-fired on every launch. Keep stored nothing; Push
 * stored a carry for next week but left the load in this week; after Reduce the
 * re-priced plan made the overshoot rise and the same sessions were proposed
 * again. "Next launch" here is a fresh collectTriSuggestions on the saved state,
 * which is what main.ts runs on launch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { showTriSuggestionModal } from './tri-suggestion-modal';
import { collectTriSuggestions } from '@/calculations/tri-suggestion-aggregator';
import { setState, resetState, getState } from '@/state/store';
import type { SimulatorState } from '@/types/state';

// 510 TSS planned week; every session on Sunday so it is upcoming on any day.
function week(extraAdhoc: any[] = []) {
  return {
    w: 1, ph: 'build', rated: {},
    triWorkouts: [
      { id: 'r-thr', t: 'threshold', n: 'Run threshold', d: '60min', r: 8, rpe: 8, discipline: 'run', aerobic: 80, anaerobic: 30, dayOfWeek: 6, estimatedDurationMin: 60 },
      { id: 's-end', t: 'swim_endurance', n: 'Swim endurance', d: '45min', r: 4, discipline: 'swim', aerobic: 60, anaerobic: 10, dayOfWeek: 6, estimatedDurationMin: 45 },
      { id: 'b-end', t: 'bike_endurance', n: 'Long bike', d: '4h', r: 5, discipline: 'bike', aerobic: 200, anaerobic: 20, dayOfWeek: 6, estimatedDurationMin: 240 },
      { id: 'r-long', t: 'long', n: 'Long run', d: '90min', r: 6, discipline: 'run', aerobic: 100, anaerobic: 10, dayOfWeek: 6, estimatedDurationMin: 90 },
    ],
    // 220 TSS of padel (iTrimp 33000) on top: 43% overshoot.
    adhocWorkouts: [{ id: 'padel', t: 'cross', n: 'padel', d: '150min', r: 7, iTrimp: 33000 }, ...extraAdhoc],
    garminActuals: {},
  };
}

function triState(): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 1,
    wks: [week(), week([])],
    triConfig: { distance: 'ironman', fitness: { swim: { ctl: 0, atl: 0, tsb: 0 }, bike: { ctl: 0, atl: 0, tsb: 0 }, run: { ctl: 0, atl: 0, tsb: 0 }, combinedCtl: 0 } },
  } as unknown as SimulatorState;
}

const overloadMod = () => collectTriSuggestions(getState()).mods.find(m => m.source === 'cross_training_overload');

async function answer(buttonId: string): Promise<number> {
  const bundle = collectTriSuggestions(getState());
  expect(bundle.mods.some(m => m.source === 'cross_training_overload')).toBe(true);
  const done = showTriSuggestionModal(bundle);
  const btn = document.getElementById(buttonId);
  expect(btn).not.toBeNull();
  btn!.click();
  return done;
}

describe('tri suggestion modal: overload answers are remembered for the week', () => {
  beforeEach(() => { resetState(); setState(triState()); });
  afterEach(() => { document.getElementById('tri-suggestion-overlay')?.remove(); });

  it('Reduce: applies the changes and the overload is not proposed on the next launch', async () => {
    expect(await answer('tri-sm-reduce')).toBeGreaterThan(0);
    expect(getState().wks[0].triWorkouts!.find(w => w.id === 'r-thr')!.status).toBe('reduced');
    expect(overloadMod()).toBeUndefined();
  });

  it('Replace & Reduce: the overload is not proposed on the next launch', async () => {
    expect(await answer('tri-sm-replace')).toBeGreaterThan(0);
    expect(overloadMod()).toBeUndefined();
  });

  it('Keep: changes nothing and the overload is not proposed on the next launch', async () => {
    const before = structuredClone(getState().wks[0].triWorkouts);
    expect(await answer('tri-sm-keep')).toBe(0);
    expect(getState().wks[0].triWorkouts).toEqual(before);
    expect(overloadMod()).toBeUndefined();
  });

  it('Push: carries the load to next week and it leaves this week\'s count', async () => {
    expect(await answer('tri-sm-push')).toBe(0);
    expect(getState().wks[0].carriedCrossTrainingTSS).toBe(220);
    expect(overloadMod()).toBeUndefined();
  });

  it('closing on the backdrop counts as Keep', async () => {
    const bundle = collectTriSuggestions(getState());
    const done = showTriSuggestionModal(bundle);
    const overlay = document.getElementById('tri-suggestion-overlay')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await done).toBe(0);
    expect(overloadMod()).toBeUndefined();
  });

  it('a new session logged after Keep proposes again, built on the new load only', async () => {
    await answer('tri-sm-keep');
    (getState().wks[0].adhocWorkouts as any[]).push({ id: 'padel-2', t: 'cross', n: 'padel', d: '150min', r: 7, iTrimp: 33000 });
    const again = overloadMod();
    expect(again).toBeDefined();
    expect(again!.overloadOptions!.crossTrainingTSS).toBe(220);
  });
});

describe('tri suggestion modal: Replace & Reduce shows only when it replaces something', () => {
  beforeEach(() => {
    resetState();
    const st = triState();
    // A ride instead of padel: bike is recommended, and bike's only session is
    // the long endurance ride, so there is nothing to swap.
    (st.wks[0] as any).adhocWorkouts = [{ id: 'ride', t: 'cross', n: 'cycling', d: '150min', r: 7, iTrimp: 33000 }];
    setState(st);
  });
  afterEach(() => { document.getElementById('tri-suggestion-overlay')?.remove(); });

  it('hidden for a discipline with no swap, shown after flipping to one with a swap', () => {
    const bundle = collectTriSuggestions(getState());
    expect(overloadMod()!.overloadOptions!.recommendedDiscipline).toBe('bike');
    void showTriSuggestionModal(bundle);
    const replace = document.getElementById('tri-sm-replace') as HTMLElement;
    expect(replace.style.display).toBe('none');
    expect(document.getElementById('tri-sm-overload-body')!.textContent).not.toContain('Replace');
    (document.getElementById('tri-sm-chip-run') as HTMLElement).click();
    expect(replace.style.display).toBe('');
    expect(document.getElementById('tri-sm-overload-body')!.textContent).toContain('Replace');
    (document.getElementById('tri-sm-chip-bike') as HTMLElement).click();
    expect(replace.style.display).toBe('none');
  });
});

describe('tri suggestion modal: only choices the discipline can act on', () => {
  afterEach(() => { document.getElementById('tri-suggestion-overlay')?.remove(); });

  const swap = { workoutId: 'r-thr', workoutLabel: 'Run threshold', discipline: 'run', action: 'swap_easy', tssReduction: 40 } as const;
  const opt = (discipline: string, reduceMods: any[], replaceMods: any[]) =>
    ({ discipline, remainingTSS: 100, floorTSS: 0, belowFloor: false, reduceMods, replaceMods });
  const bundle = () => ({
    mods: [{
      id: 'xt_overload_run', source: 'cross_training_overload', discipline: 'run', headline: '', body: '', severity: 'caution',
      action: 'swap_easy', targetWorkoutId: 'r-thr',
      overloadOptions: {
        crossTrainingTSS: 60, plannedTriTSS: 300, overshootPct: 0.2, severity: 'heavy', recommendedDiscipline: 'run',
        options: { run: opt('run', [], [swap]), bike: opt('bike', [], []), swim: opt('swim', [], []) },
      },
    }],
    diagnostics: { rampViolations: 0, rpeBlown: false, readinessLabel: null, crossTrainingOverload: true },
  }) as any;

  it('a Replace-only option opens with no empty Reduce list and no Reduce button', () => {
    void showTriSuggestionModal(bundle());
    const body = document.getElementById('tri-sm-overload-body')!;
    expect(body.textContent).not.toContain('No upcoming workouts');
    expect(body.textContent).toContain('Replace');
    expect((document.getElementById('tri-sm-reduce') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('tri-sm-replace') as HTMLElement).style.display).toBe('');
  });

  it('a discipline flipped to with no change says so and offers only Keep and Push', () => {
    void showTriSuggestionModal(bundle());
    (document.getElementById('tri-sm-chip-bike') as HTMLElement).click();
    expect(document.getElementById('tri-sm-overload-body')!.textContent).toContain('No upcoming workouts to adjust.');
    expect((document.getElementById('tri-sm-reduce') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('tri-sm-replace') as HTMLElement).style.display).toBe('none');
    expect(document.getElementById('tri-sm-keep')).not.toBeNull();
    expect(document.getElementById('tri-sm-push')).not.toBeNull();
  });
});

describe('tri suggestion modal: generic rows are remembered for the week', () => {
  afterEach(() => {
    document.getElementById('tri-suggestion-overlay')?.remove();
    vi.useRealTimers();
  });

  // Poor readiness (heavy leg load) + a quality run today fires the readiness row.
  function readinessState(): SimulatorState {
    const disc = { ctl: 70, atl: 56, tsb: 14, directCount: 5 };
    return {
      eventType: 'triathlon',
      w: 1,
      physiologyHistory: [],
      recentLegLoads: [{ load: 80, sport: 'strength', sportLabel: 'Strength', timestampMs: Date.now(), recoveryMultOverride: 1.2 }],
      triConfig: { distance: 'ironman', fitness: { swim: { ...disc }, bike: { ...disc }, run: { ...disc } }, fitnessHistory: [{}, {}, {}, {}] },
      wks: [{ w: 1, ph: 'build', rated: {}, triWorkouts: [{ id: 'wed-thr', t: 'threshold', n: 'Threshold run', d: '60min', r: 8, rpe: 8, discipline: 'run', dayOfWeek: 2, estimatedDurationMin: 60 }] }],
    } as unknown as SimulatorState;
  }

  for (const [label, buttonId] of [['Dismiss', 'tri-sm-dismiss'], ['Apply', 'tri-sm-accept']] as const) {
    it(`${label}: the readiness row is not proposed on the next launch`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // local Wednesday (dow 2)
      resetState();
      setState(readinessState());
      const bundle = collectTriSuggestions(getState());
      expect(bundle.mods.some(m => m.source === 'readiness')).toBe(true);
      const done = showTriSuggestionModal(bundle);
      document.getElementById(buttonId)!.click();
      await done;
      expect(collectTriSuggestions(getState()).mods.find(m => m.source === 'readiness')).toBeUndefined();
    });
  }

  // RPE-blown (yesterday's easy run rated 8 vs 4) and readiness both fire on
  // today's threshold run. The modal shows one merged row; dismissing it answers
  // both detectors, so the readiness downgrade does not come back on its own.
  it('Dismiss on a merged RPE + readiness row answers both for the week', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // local Wednesday (dow 2)
    resetState();
    const s = readinessState() as any;
    s.wks[0].rated = { 'tue-easy': 8 };
    s.wks[0].triWorkouts.unshift({ id: 'tue-easy', t: 'easy', n: 'Easy run', d: '40min', r: 4, rpe: 4, discipline: 'run', dayOfWeek: 1, estimatedDurationMin: 40 });
    setState(s);
    const bundle = collectTriSuggestions(getState());
    const rows = bundle.mods.filter(m => m.targetWorkoutId === 'wed-thr');
    expect(rows).toHaveLength(1);
    expect(document.querySelectorAll('[id^="tri-sm-mod-"]').length).toBe(0);
    const done = showTriSuggestionModal(bundle);
    expect(document.querySelectorAll('[id^="tri-sm-mod-"]').length).toBe(1);
    document.getElementById('tri-sm-dismiss')!.click();
    await done;
    expect(collectTriSuggestions(getState()).mods.filter(m => m.targetWorkoutId === 'wed-thr')).toEqual([]);
  });
});
