// @vitest-environment jsdom
/**
 * A tri / cycling session swapped to easy by an accepted suggestion is still to
 * be done, so every surface keeps it. Regression (review of a1/a2): the swap set
 * status 'replaced', which the tri Home Today list drops (so the session
 * vanished from Home, or Home showed "Rest Day"), while getPlannedDayTSSContext
 * still priced it and the plan card labelled it "Replaced". The swap now sets
 * 'reduced', the status the Adjust overlay uses for the same reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { buildTodayWorkoutTriathlon } from './home-view';
import { getPlannedDayTSSContext } from './planned-day-tss';
import { resolveTriWeekWorkouts } from './triathlon/week-resolve.triathlon';
import { applyTriSuggestions } from '@/calculations/tri-suggestion-apply';
import type { TriSuggestionMod } from '@/calculations/tri-suggestion-aggregator';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { setState, resetState, getDefaultState } from '@/state/store';
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

const load = (w: Workout) => (w.aerobic ?? 0) + (w.anaerobic ?? 0);
const LOCAL_MONDAY = new Date(2026, 9, 5, 12, 0, 0); // dow 0

describe('a session swapped to easy today stays on every surface', () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => { resetState(); });

  it('appears on the tri Today list and in the planned-day TSS', () => {
    const s = realTriState();
    // First generated bike threshold; make the state's current week its week
    // and today its weekday, with no other session on that day.
    let weekNo = 0;
    let w: Workout | undefined;
    for (let i = 0; i < s.wks.length && !w; i++) {
      w = s.wks[i].triWorkouts?.find(x => x.t === 'bike_threshold');
      if (w) weekNo = i + 1;
    }
    expect(w).toBeDefined();
    s.w = weekNo;
    const wk = s.wks[weekNo - 1];
    const day = w!.dayOfWeek!;
    wk.triWorkouts = wk.triWorkouts!.filter(x => x === w || x.dayOfWeek !== day);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(LOCAL_MONDAY.getTime() + day * 86400000));
    setState(s);

    const mod: TriSuggestionMod = {
      id: 'readiness_x', source: 'readiness', discipline: 'bike', headline: 'h', body: 'b',
      severity: 'warning', targetWorkoutId: w!.id, action: 'swap_easy',
    };
    expect(applyTriSuggestions(s, [mod]).applied).toBe(1);
    expect(w!.t).toBe('bike_endurance');

    // Home Today: the swapped session is listed, not a rest day.
    const html = buildTodayWorkoutTriathlon(s);
    expect(html).toContain('Easy Bike');
    expect(html).not.toContain('Rest Day');
    expect(w!.status).toBe('reduced');

    // The plan view's resolved week keeps it as an active session.
    const resolved = resolveTriWeekWorkouts(s, weekNo).find(x => x.id === w!.id);
    expect(resolved?.status).toBe('reduced');

    // Planned-day TSS prices it at its new (easy) load.
    expect(getPlannedDayTSSContext(s, weekNo).plannedTSSForDay(day)).toBe(load(w!));
  });
});
