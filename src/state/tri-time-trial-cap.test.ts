/**
 * The triathlon run Time Trial reads the cold-start capped figure (modes
 * review, 2026-10-12).
 *
 * bdeedf3 moved the session generator's Time Trial onto
 * predictStandardDistances. Its blend took the watch VO2max uncapped
 * (effectiveVo2max), while the engine, s.lt and the run leg are held at the
 * run skill-slider VDOT for a triathlete with no running evidence
 * (triColdStartRunCapVdot). Measured: 70.3, watch 62, run skill 2: engine
 * 35.5 (5K 26:39) but a Time Trial 5K of 23:28.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
});
vi.stubGlobal('alert', vi.fn());
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { initializeTriathlonSimulator } from './initialization.triathlon';
import { getMutableState, resetState } from './store';
import { refreshBlendedFitness, predictStandardDistances } from '@/calculations/blended-fitness';
import { timeTrialPredictions } from '@/ui/session-generator';
import { vt } from '@/calculations/vdot';
import { triColdStartRunCapVdot } from '@/calculations/physiological-vdot';
import { localMondayKey } from '@/utils/local-date';

const FROZEN_NOW = new Date();
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(FROZEN_NOW);
afterAll(() => { vi.useRealTimers(); });

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function initTri(seed: Partial<SimulatorState>, runSkill: 1 | 2 | 3 | 4 | 5): SimulatorState {
  resetState();
  Object.assign(getMutableState(), seed);
  expect(initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
    customRaceDate: planDay(16, 6), triSkillRating: { swim: 3, bike: 3, run: runSkill },
  } as OnboardingState).success).toBe(true);
  const s = getMutableState();
  refreshBlendedFitness(s);
  return s;
}

describe('triathlon cold start: the Time Trial is not faster than the capped figure', () => {
  for (const [label, seed, skill] of [
    ['watch 62, run skill 2', { vo2: 62 }, 2],
    ['watch 62, run skill 3', { vo2: 62 }, 3],
    ['watch 55, run skill 3', { vo2: 55 }, 3],
  ] as const) {
    it(label, () => {
      const s = initTri(seed, skill);
      const cap = triColdStartRunCapVdot(s);
      expect(cap).not.toBeNull();
      const tt5k = timeTrialPredictions(s).find(d => d.km === 5)?.predictedSec ?? null;
      expect(tt5k).not.toBeNull();
      expect(tt5k!).toBeGreaterThanOrEqual(vt(5, cap!) - 1e-6);
      // Every standard distance reads the same capped figure.
      const std = predictStandardDistances(s);
      expect(std['5k']).toBe(tt5k);
      expect(std['10k']!).toBeGreaterThanOrEqual(vt(10, cap!) - 1e-6);
    });
  }

  it('running evidence lifts the cap, so a triathlete with a half PB keeps the uncapped blend', () => {
    resetState();
    Object.assign(getMutableState(), { vo2: 62 });
    expect(initializeTriathlonSimulator({
      trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
      customRaceDate: planDay(16, 6), triSkillRating: { swim: 3, bike: 3, run: 2 }, pbs: { h: 5400 },
    } as OnboardingState).success).toBe(true);
    const s = getMutableState();
    refreshBlendedFitness(s);
    expect(triColdStartRunCapVdot(s)).toBeNull();
  });
});
