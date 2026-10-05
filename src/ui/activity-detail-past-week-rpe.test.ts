// @vitest-environment jsdom
/**
 * Activity detail's no-HR TSS estimate reads the rating from the week that
 * holds the activity (audit B2 related). It used to read only the current
 * week's rated map, so a past-week run without HR fell back to RPE 5 and
 * disagreed with that week's load total (computeWeekRawTSS reads that week).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { renderActivityDetail } from './activity-detail';
import { computeWeekRawTSS } from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import { setState, resetState, getDefaultState, getState } from '@/state/store';
import type { SimulatorState, Week } from '@/types';

function week(w: number, parts: Partial<Week> = {}): Week {
  return {
    w, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {}, adhocWorkouts: [], unspentLoadItems: [],
    garminMatched: {}, ...parts,
  } as unknown as Week;
}

function shownEstimatedTSS(): number | null {
  const labels = Array.from(document.querySelectorAll('#app-root div'))
    .filter(el => el.children.length === 0 && el.textContent === 'TSS (est)');
  if (labels.length === 0) return null;
  const value = labels[0].previousElementSibling?.textContent ?? '';
  return value ? parseInt(value, 10) : null;
}

describe('Activity detail no-HR TSS uses the rating from the activity\'s own week', () => {
  beforeEach(() => {
    resetState();
    document.body.innerHTML = '<div id="app-root"></div>';
  });

  it('a past-week RPE-7 run shows the RPE-7 estimate, the same as that week\'s load total', () => {
    const id = 'W2-threshold-0';
    const actual = {
      garminId: 'strava-321', startTime: '2026-03-10T07:00:00Z', durationSec: 40 * 60,
      distanceKm: 8, activityType: 'RUNNING', displayName: 'Tempo',
    };
    setState({
      ...getDefaultState(),
      w: 4,
      wks: [week(1), week(2, { garminActuals: { [id]: actual } as any, rated: { [id]: 7 } }), week(3), week(4)],
    } as unknown as SimulatorState);

    const stored = getState().wks![1].garminActuals![id];
    renderActivityDetail(stored as any, 'Tempo', 'plan', 50, id);

    const expected = Math.round(40 * TL_PER_MIN[7]);
    expect(shownEstimatedTSS()).toBe(expected);
    expect(shownEstimatedTSS()).not.toBe(Math.round(40 * TL_PER_MIN[5]));
    const wk2 = getState().wks![1];
    expect(computeWeekRawTSS(wk2, wk2.rated)).toBe(expected);
  });
});
