/**
 * A session skipped from its tri, cycling or HYROX card leaves that day's
 * planned load.
 *
 * Before: getPlannedDayTSSContext's tri/HYROX branch dropped only
 * status 'skipped' (tri-skip-handler's push/drop, which no UI calls). The card's
 * Skip writes wk.rated[key] = 'skip' and never sets status
 * (triathlon setRated, HYROX setHxRated), so a skipped day kept its target on
 * the Home strain ring (HYROX: Tuesday stayed at 62 TSS).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('alert', vi.fn());

import { getPlannedDayTSSContext } from './planned-day-tss';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { resetState, getMutableState } from '@/state/store';
import type { SimulatorState, Workout } from '@/types';

/** What setRated / setHxRated write for the card's Skip. */
function skipFromCard(s: SimulatorState, w: Workout): void {
  s.wks[0].rated[w.id ?? w.n] = 'skip';
}

function hyroxState(): SimulatorState {
  initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8,
  } as any);
  const s = getMutableState();
  expect(s.eventType).toBe('hyrox');
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 28, 9, 0, 0)); // onboard on the plan's Monday
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorageMock.clear();
  resetState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a card Skip takes the session off the day in tri and HYROX', () => {
  it('HYROX: skipping Tuesday\'s Tempo Run leaves Tuesday with no planned load', () => {
    const s = hyroxState();
    const tempo = s.wks[0].triWorkouts!.find(w => w.n === 'Tempo Run')!;
    const day = tempo.dayOfWeek!;
    expect(getPlannedDayTSSContext(s, 1).plannedTSSForDay(day)).toBeGreaterThan(0);

    skipFromCard(s, tempo);

    expect(getPlannedDayTSSContext(s, 1).plannedTSSForDay(day)).toBe(0); // was 62
  });

  it('triathlon: skipping a swim drops that swim\'s load from its day', () => {
    initializeTriathlonSimulator({ trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate' } as any);
    const s = getMutableState();
    expect(s.eventType).toBe('triathlon');
    const swim = s.wks[0].triWorkouts!.find(w => w.discipline === 'swim')!;
    const day = swim.dayOfWeek!;
    const before = getPlannedDayTSSContext(s, 1).plannedTSSForDay(day);
    const swimTss = Math.round((swim.aerobic ?? 0) + (swim.anaerobic ?? 0));
    expect(swimTss).toBeGreaterThan(0);

    skipFromCard(s, swim);

    expect(getPlannedDayTSSContext(s, 1).plannedTSSForDay(day)).toBe(before - swimTss);
    expect(getPlannedDayTSSContext(s, 1).workoutsForDay(day).some(w => w.name === swim.n)).toBe(false);
  });

  it('HYROX: skipping one Easy Run keeps the same-named Easy Run on another day (sessions with their own ids, lane f f1)', () => {
    const s = hyroxState();
    // Unique slot ids, as lane f f1 stamps them; kept when the plan already has them.
    s.wks[0].triWorkouts!.forEach((w, i) => { w.id ??= `hx-w1-${i}`; });
    const easies = s.wks[0].triWorkouts!.filter(w => w.n === 'Easy Run');
    expect(easies.length).toBe(2);
    const [first, second] = easies;
    expect(first.dayOfWeek).not.toBe(second.dayOfWeek);
    const keep = getPlannedDayTSSContext(s, 1).plannedTSSForDay(second.dayOfWeek!);
    expect(keep).toBeGreaterThan(0);

    skipFromCard(s, first);

    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedTSSForDay(first.dayOfWeek!)).toBe(0);
    expect(ctx.plannedTSSForDay(second.dayOfWeek!)).toBe(keep);
  });

  it('a session marked done keeps its planned load (only a skip leaves the day)', () => {
    const s = hyroxState();
    const tempo = s.wks[0].triWorkouts!.find(w => w.n === 'Tempo Run')!;
    const before = getPlannedDayTSSContext(s, 1).plannedTSSForDay(tempo.dayOfWeek!);
    s.wks[0].rated[tempo.id ?? tempo.n] = 7;
    expect(getPlannedDayTSSContext(s, 1).plannedTSSForDay(tempo.dayOfWeek!)).toBe(before);
  });
});
