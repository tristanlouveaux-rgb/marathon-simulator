// @vitest-environment jsdom
/**
 * Adjust -> accept a suggestion -> Adjust keeps the Adjust overlay's anchors
 * consistent. Regression (review of a2): an accepted downgrade rewrote w.t to
 * the new rung, but Adjust scales watts from its stashed baseline description
 * (originalDistance, written at the generated rung) relative to
 * originalIntensityLevel ?? w.t, which now named the post-suggestion rung. The
 * second Adjust scaled the generated threshold watts as if they were sweet-spot
 * watts (x1.099 instead of x1.00), and Reset restored the threshold description
 * and load under the sweet-spot type and "(downgrade)" name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { openWorkoutAdjust } from './workout-adjust-overlay';
import { applyTriSuggestions } from '@/calculations/tri-suggestion-apply';
import type { TriSuggestionMod } from '@/calculations/tri-suggestion-aggregator';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { scaleWattRanges } from '@/workouts/workout-scaling';
import { loadForBike } from '@/workouts/bike';
import { loadForTriRun } from '@/workouts/rung-load';
import { setState, resetState, getDefaultState, getMutableState } from '@/state/store';
import type { SimulatorState, Workout } from '@/types/state';

function realTriState(): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    w: 1,
    tw: 20,
    v: 50,
    pac: { e: 300, t: 250, i: 230, m: 275, r: 200 },
    wks: [],
    triConfig: {
      distance: '70.3',
      timeAvailableHoursPerWeek: 12,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: true, ftp: 220 },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 20,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

function sessionOf(t: string): { w: Workout; weekIdx: number } {
  const wks = getMutableState().wks;
  for (let i = 0; i < wks.length; i++) {
    const w = wks[i].triWorkouts?.find(x => x.t === t);
    if (w) return { w, weekIdx: i };
  }
  throw new Error(`no generated ${t}`);
}

const watts = (d: string) => [...d.matchAll(/(\d+)–(\d+)\s*W/g)].map(m => [Number(m[1]), Number(m[2])]);
const load = (w: any) => (w.aerobic ?? 0) + (w.anaerobic ?? 0);

function adjust(w: Workout, weekIdx: number, steps: () => void): void {
  openWorkoutAdjust(w, weekIdx, { persist: 'object', workoutId: w.id, rerender: () => {} });
  steps();
  (document.getElementById('wadj-apply') as HTMLButtonElement).click();
}
function setSlider(pct: number): void {
  const slider = document.getElementById('wadj-slider') as HTMLInputElement;
  slider.value = String(pct);
  slider.dispatchEvent(new Event('input'));
}
const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();

const modFor = (w: Workout, action: TriSuggestionMod['action']): TriSuggestionMod => ({
  id: `readiness_${w.id}`, source: 'readiness', discipline: (w.discipline ?? 'run') as any,
  headline: 'h', body: 'b', severity: 'caution', targetWorkoutId: w.id, action,
});

describe('Adjust -> accepted suggestion -> Adjust', () => {
  beforeEach(() => { resetState(); setState(realTriState()); });
  afterEach(() => { document.getElementById('workout-adjust-overlay')?.remove(); });

  it('bike: re-adjusting back to threshold after a downgrade gives the threshold watts', () => {
    const { w, weekIdx } = sessionOf('bike_threshold');
    const genDesc = w.d!;
    const genMin = w.estimatedDurationMin!;
    expect(watts(genDesc).length).toBeGreaterThan(0);

    // 1. Adjust: duration only (80%). Stashes the generated description.
    adjust(w, weekIdx, () => setSlider(80));
    expect(w.originalDistance).toBe(genDesc);

    // 2. Accept a readiness downgrade: threshold -> sweet spot.
    applyTriSuggestions(getMutableState(), [modFor(w, 'downgrade_today')]);
    expect(w.t).toBe('bike_sweet_spot');
    expect(w.intensityLevel).toBe('bike_sweet_spot');

    // 3. Adjust again, one rung harder (back to threshold).
    adjust(w, weekIdx, () => click('wadj-harder'));
    expect(w.intensityLevel).toBe('bike_threshold');
    // Threshold watts: the baseline was rebased to sweet spot, then scaled back.
    const expected = watts(scaleWattRanges(scaleWattRanges(genDesc, 0.91), 1 / 0.91));
    expect(watts(w.d!)).toEqual(expected);
    for (const [i, [lo, hi]] of watts(genDesc).entries()) {
      expect(Math.abs(watts(w.d!)[i][0] - lo)).toBeLessThanOrEqual(1);
      expect(Math.abs(watts(w.d!)[i][1] - hi)).toBeLessThanOrEqual(1);
    }

    // 4. Reset: back to the plan as the suggestion left it (sweet spot), every
    // field agreeing with w.t.
    openWorkoutAdjust(w, weekIdx, { persist: 'object', workoutId: w.id, rerender: () => {} });
    click('wadj-reset');
    expect(w.t).toBe('bike_sweet_spot');
    expect(w.intensityLevel).toBeUndefined();
    expect(watts(w.d!)).toEqual(watts(scaleWattRanges(genDesc, 0.91)));
    expect(w.estimatedDurationMin).toBe(genMin);
    const ss = loadForBike('sweet_spot', genMin);
    expect(load(w)).toBe(ss.aerobic + ss.anaerobic);
  });

  it('bike: a swap on an adjusted session moves the baseline to the easy rung at 75% of the plan minutes', () => {
    const { w, weekIdx } = sessionOf('bike_threshold');
    const genDesc = w.d!;
    const genMin = w.estimatedDurationMin!;
    adjust(w, weekIdx, () => setSlider(80));
    applyTriSuggestions(getMutableState(), [modFor(w, 'swap_easy')]);
    expect(w.t).toBe('bike_endurance');
    expect(w.originalDurationMin).toBe(Math.round(genMin * 0.75));

    openWorkoutAdjust(w, weekIdx, { persist: 'object', workoutId: w.id, rerender: () => {} });
    click('wadj-reset');
    expect(w.intensityLevel).toBeUndefined();
    expect(watts(w.d!)).toEqual(watts(scaleWattRanges(genDesc, 0.65)));
    expect(w.estimatedDurationMin).toBe(Math.round(genMin * 0.75));
    const end = loadForBike('endurance', Math.round(genMin * 0.75));
    expect(load(w)).toBe(end.aerobic + end.anaerobic);
  });

  it('run: Reset after a downgrade keeps the new pace and load (no threshold pace back under a marathon-pace type)', () => {
    const { w, weekIdx } = sessionOf('threshold');
    const genMin = w.estimatedDurationMin!;
    adjust(w, weekIdx, () => setSlider(80));
    applyTriSuggestions(getMutableState(), [modFor(w, 'downgrade_today')]);
    expect(w.t).toBe('marathon_pace');

    openWorkoutAdjust(w, weekIdx, { persist: 'object', workoutId: w.id, rerender: () => {} });
    click('wadj-reset');
    expect(w.t).toBe('marathon_pace');
    expect(w.d).toMatch(/@ MP \(/);
    expect(w.estimatedDurationMin).toBe(genMin);
    const mp = loadForTriRun('marathon_pace', genMin)!;
    expect(load(w)).toBe(mp.aerobic + mp.anaerobic);
  });
});
