// @vitest-environment jsdom
/**
 * The Rolling Load drill-down shows the same 7-day load, 28-day average, label
 * and ring as the Readiness "7-Day Rolling Load" card that opens it. Both read
 * computeReadinessACWR. The drill-down used to call computeACWR with its own
 * seed (the Signal A atlSeed, or 0 with an archive / in just-track), and drew
 * its ring arc from a third seed.
 *
 * Time is pinned at LOCAL noon in June 2026 (no daylight-saving change inside).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { renderRollingLoadView } from './rolling-load-view';
import { computeReadinessACWR } from '@/calculations/fitness-model';
import { setState } from '@/state/store';
import type { SimulatorState, Week } from '@/types';

const PLAN_START = '2026-06-01'; // Monday
const localNoon = (planDay: number) => new Date(2026, 5, 1 + planDay, 12, 0, 0, 0);
const dateKey = (planDay: number) => localNoon(planDay).toISOString().split('T')[0];
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });
// jsdom has no SVG geometry; the chart draw-on animation only needs a length.
if (!(SVGElement.prototype as any).getTotalLength) (SVGElement.prototype as any).getTotalLength = () => 100;

function buildWeeks(minutesForDay: (planDay: number) => number, startDay = 0, count = 16): Week[] {
  const wks = Array.from({ length: count }, (_, i) => ({
    w: i + 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {},
  })) as unknown as Week[];
  for (let day = startDay; day < startDay + count * 7; day++) {
    const min = minutesForDay(day);
    if (min <= 0) continue;
    wks[Math.floor((day - startDay) / 7)].garminActuals![`run-${day}`] = {
      garminId: `g-${day}`, startTime: `${dateKey(day)}T07:00:00.000Z`, distanceKm: 10,
      durationSec: min * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
      iTrimp: null, activityType: 'RUNNING',
    } as any;
  }
  return wks;
}

function state(overrides: Partial<SimulatorState>): SimulatorState {
  return {
    w: 1, tw: 16, v: 45, iv: 45, rpeAdj: 0, expectedFinal: 48, rd: 'marathon' as any, epw: 5, rw: 4,
    wkm: 50, pbs: {} as any, rec: null, lt: null, vo2: null, initialLT: null, initialVO2: null,
    initialBaseline: null, currentFitness: null, forecastTime: null, typ: 'balanced' as any, b: 1.06,
    pac: { e: 330 } as any, skip: [], timp: 0, physiologyHistory: [], historicWeeklyTSS: [],
    recentLegLoads: [], planStartDate: PLAN_START,
    ...overrides,
  } as SimulatorState;
}

const RING_C = +(2 * Math.PI * 46).toFixed(2);

function render(s: SimulatorState, planDay: number) {
  vi.useFakeTimers();
  vi.setSystemTime(localNoon(planDay));
  setState(s);
  document.body.innerHTML = '<div id="app-root"></div>';
  renderRollingLoadView();
  vi.advanceTimersByTime(60); // ring arc animates in after 50 ms
  const text = document.getElementById('app-root')!.textContent!.replace(/\s+/g, ' ');
  const m = /(\d+) TSS (High|Normal|Low)/.exec(text)!;
  const avg = Number(/28d avg: (\d+)/.exec(text)![1]);
  const circle = document.getElementById('rl-ring-circle') as unknown as SVGCircleElement;
  return { acute: Number(m[1]), label: m[2], avg, offset: Number(circle.style.strokeDashoffset) };
}

/** What the Readiness card shows for the same state (readiness-view.ts card rule). */
function readinessCard(s: SimulatorState) {
  const a = computeReadinessACWR(s);
  const acute = Math.round(a.atl), avg = Math.round(a.ctl);
  const label = acute > avg * 1.3 ? 'High' : acute > avg * 0.8 ? 'Normal' : 'Low';
  const ratio = avg > 0 ? acute / avg : 0;
  const offset = +(RING_C * (1 - Math.min(ratio / 1.3 * 100, 100) / 100)).toFixed(2);
  return { acute, label, avg, offset };
}

describe('Rolling Load drill-down agrees with the Readiness card', () => {
  it('seeded athlete with gym sessions, no archive (drill-down used the Signal A atlSeed)', () => {
    const s = state({ signalBBaseline: 7 * 46, ctlBaseline: 250, gs: 2, wks: buildWeeks(() => 40) });
    const view = render(s, 3);
    expect(view).toEqual(readinessCard(s));
    expect(view.avg).toBe(7 * 46);
  });

  it('short archive after a rebuild (drill-down seeded 0 and read High against Normal)', () => {
    // New plan started 3 days ago; the archive covers only the 7 days before it.
    const archive = { planStartDate: dateKey(-7), weeks: buildWeeks(() => 40, -7, 1) };
    const s = state({
      signalBBaseline: 7 * 46, ctlBaseline: 250, wks: buildWeeks(() => 40),
      previousPlanWks: [archive] as any,
    });
    const view = render(s, 3);
    expect(view).toEqual(readinessCard(s));
    expect(view.label).toBe('Normal');
  });

  it('just-track athlete (drill-down showed 0 TSS against the card\'s real load)', () => {
    const s = state({ trackOnly: true, tw: 1, signalBBaseline: 7 * 46, ctlBaseline: 250, wks: buildWeeks(() => 40, 0, 1) });
    const view = render(s, 5);
    expect(view).toEqual(readinessCard(s));
    expect(view.acute).toBeGreaterThan(0);
  });
});
