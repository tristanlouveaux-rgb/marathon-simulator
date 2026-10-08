import { describe, it, expect, afterEach, vi } from 'vitest';

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

import { generateGymWorkouts } from './gym';
import { isRunningDeloadWeek, abilityBandFromVdot } from './plan_engine';
import { generateWeekWorkouts } from './generator';
import { initializeSimulator } from '@/state/initialization';
import { getState, resetState } from '@/state/store';
import type { OnboardingState } from '@/types/onboarding';
import type { TrainingPhase } from '@/types';

/**
 * Strength deloads the same week as the runs (isRunningDeloadWeek, 6df2908).
 * A continuous plan repeats Base, Build, Intensify ('peak'), Deload ('taper');
 * the runs deload the Deload week. On the ability cycle a beginner or novice
 * (every 3rd week) cut a strength session and marked the rest "(Deload)" in
 * the Intensify week, and an advanced runner deloaded week 5.
 */

const BLOCK: TrainingPhase[] = ['base', 'build', 'peak', 'taper'];
const phaseOf = (week: number) => BLOCK[(week - 1) % 4];

function gym(week: number, level: string, vdot: number, continuous: boolean, phase: TrainingPhase = phaseOf(week)) {
  return generateGymWorkouts(
    phase, 3, level, week, 16, vdot, null, undefined, undefined, undefined, false, undefined, continuous,
  );
}
const deloaded = (ws: ReturnType<typeof gym>) => ws.some(w => w.n.endsWith('(Deload)'));

describe('continuous plan: strength deloads the block Deload week', () => {
  // [experience, VDOT] covering novice (cycle 3), intermediate (4), advanced (5).
  const RUNNERS: Array<[string, number]> = [['beginner', 35], ['intermediate', 45], ['advanced', 55]];

  for (const [level, vdot] of RUNNERS) {
    it(`${level}: no deload outside the Deload week; the Deload week matches the runs`, () => {
      const ability = abilityBandFromVdot(vdot, level);
      for (let week = 1; week <= 12; week++) {
        const phase = phaseOf(week);
        const ws = gym(week, level, vdot, true);
        const runsDeload = isRunningDeloadWeek(week, ability, phase, true);
        expect(runsDeload, `week ${week}`).toBe(week > 1 && phase === 'taper');
        if (!runsDeload) {
          expect(deloaded(ws), `${level} week ${week} (${phase})`).toBe(false);
          // Same sessions as the phase gets with no deload at all.
          expect(ws.length, `${level} week ${week}`).toBe(gym(1, level, vdot, true, phase).length);
        } else {
          // The Deload week drops one session from the taper count.
          expect(ws.length, `${level} week ${week}`).toBe(Math.max(0, gym(1, level, vdot, true, phase).length - 1));
        }
      }
    });
  }

  it('beginner Intensify week (week 3) keeps its strength session (dropped on the ability cycle before)', () => {
    expect(gym(3, 'beginner', 35, true).length).toBe(1);
    expect(deloaded(gym(3, 'beginner', 35, true))).toBe(false);
  });
});

describe('race plan: strength keeps the ability cycle', () => {
  it('novice deloads every 3rd week, intermediate every 4th', () => {
    expect(deloaded(gym(3, 'beginner', 35, false, 'base'))).toBe(true);
    expect(deloaded(gym(4, 'beginner', 35, false, 'base'))).toBe(false);
    expect(deloaded(gym(4, 'intermediate', 45, false, 'base'))).toBe(true);
    expect(deloaded(gym(3, 'intermediate', 45, false, 'base'))).toBe(false);
  });
});

describe('continuous plan, real path (initializeSimulator then generateWeekWorkouts)', () => {
  afterEach(() => { resetState(); localStorageMock.clear(); vi.restoreAllMocks(); });

  it('beginner with 3 strength sessions: the Intensify week keeps full strength; the Deload week deloads it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetState();
    const res = initializeSimulator({
      trainingMode: 'running', trainingForEvent: false, planDurationWeeks: 8, pbs: {},
      experienceLevel: 'beginner', runsPerWeek: 3, gymSessionsPerWeek: 3,
    } as OnboardingState);
    expect(res.success).toBe(true);
    const s = getState();
    expect(s.continuousMode).toBe(true);
    const strength = (k: number) => {
      const wk = s.wks[k - 1];
      return generateWeekWorkouts(
        wk.ph, s.rw, s.rd, s.typ, [], undefined, null, undefined,
        s.onboarding?.experienceLevel, undefined, s.pac?.e, k, s.tw, s.v, s.gs,
      ).filter(w => w.t === 'gym');
    };
    expect(s.wks.slice(0, 4).map(w => w.ph)).toEqual(['base', 'build', 'peak', 'taper']);
    const intensify = strength(3);
    expect(intensify.length).toBe(generateGymWorkouts('peak', 3, 'beginner').length);
    expect(intensify.some(w => w.n.endsWith('(Deload)'))).toBe(false);
    // The Deload week: one session fewer than the taper count.
    expect(strength(4).length).toBe(Math.max(0, generateGymWorkouts('taper', 3, 'beginner').length - 1));
  });
});
