/**
 * Triathlon run paces follow the capped figure (decided by Tristan, 2026-10-09).
 *
 * Training paces come from s.lt whenever it is set (gp, paces.ts), and s.lt's
 * Daniels input was getPhysiologicalVdot, whose device tier returns the raw
 * watch VO2max. A triathlete's watch is built by cycling and swimming too, so
 * a 70.3 athlete at run skill 3 with watch 62 and no running evidence had
 * s.lt 220 s/km and easy runs at 4:24/km, while the engine VDOT was already
 * held at the run skill rating (44.3). The Daniels input now applies the same
 * caps that hold the blend (effectiveVo2max's running-evidence ceiling) and
 * the engine (the cold-start skill cap): ltDanielsInputVdot.
 */
import { describe, it, expect, vi } from 'vitest';
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

import {
  ltDanielsInputVdot, getPhysiologicalVdot, triColdStartRunCapVdot, effectiveVo2max, pbMedianVdot,
} from './physiological-vdot';
import { runSkillVdot, estimateRunPaceFromSkill } from './tri-run-skill';
import { deriveLTFromVdot } from './lt-derivation';
import { cv } from './vdot';
import { recomputeLT } from '@/data/ltSync';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { getDefaultState, getMutableState, getState, resetState } from '@/state/store';
import { refreshBlendedFitness } from './blended-fitness';
import { triRunEasyPaceSec } from '@/workouts/tri-run-pace';
import { localMondayKey } from '@/utils/local-date';

const NOW = '2026-10-09T08:00:00Z';
const SKILL3 = cv(42195, estimateRunPaceFromSkill(3, 'ironman') * 42.195);

function tri(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'triathlon',
    triConfig: { distance: '70.3', skillRating: { swim: 3, bike: 3, run: 3 } } as SimulatorState['triConfig'],
    ...overrides,
  } as SimulatorState;
}

describe('ltDanielsInputVdot: the triathlete run caps reach the LT input', () => {
  it('run skill 3 is 44.3, the figure the cold-start cap holds', () => {
    expect(runSkillVdot(3)).toBeCloseTo(SKILL3, 9);
    expect(SKILL3).toBeCloseTo(44.3, 1);
  });

  it('a watch of 62 with no running evidence is held at the run skill rating', () => {
    const s = tri({ vo2: 62 });
    expect(getPhysiologicalVdot(s, { now: NOW }).source).toBe('device');
    expect(getPhysiologicalVdot(s, { now: NOW }).vdot).toBe(62);
    expect(triColdStartRunCapVdot(s, { recentRaceEffort: false })).toBeCloseTo(SKILL3, 9);
    expect(ltDanielsInputVdot(s, { now: NOW })).toBeCloseTo(SKILL3, 9);
  });

  it('recomputeLT derives s.lt from the capped figure, not the watch', () => {
    const s = tri({ vo2: 62 });
    recomputeLT(s, { now: NOW, garmin: null });
    expect(s.lt).toBe(Math.round(deriveLTFromVdot(SKILL3)!));
    expect(s.lt).toBe(288);
    // Pre-fix: Daniels from the raw watch.
    expect(Math.round(deriveLTFromVdot(62)!)).toBe(220);
  });

  it('a watch below the skill rating is used as it is', () => {
    const s = tri({ vo2: 40 });
    expect(ltDanielsInputVdot(s, { now: NOW })).toBe(40);
  });

  it('with a race PB the watch is capped at the PB median, as effectiveVo2max caps the blend', () => {
    const pbs = { k10: 3000 };  // 10K in 50:00
    const s = tri({ vo2: 62, pbs });
    const pb = pbMedianVdot(pbs)!;
    expect(pb).toBeLessThan(SKILL3);
    expect(getPhysiologicalVdot(s, { now: NOW }).source).toBe('device');
    expect(ltDanielsInputVdot(s, { now: NOW })).toBeCloseTo(pb, 9);
    expect(effectiveVo2max(s, new Date(NOW))).toBeCloseTo(pb, 9);
  });

  it('a medium HR fit above the skill rating sets the ceiling instead of the skill rating', () => {
    const s = tri({ vo2: 62, hrCalibratedVdot: { vdot: 48, confidence: 'medium', n: 6, r2: 0.6 } as SimulatorState['hrCalibratedVdot'] });
    expect(triColdStartRunCapVdot(s, { recentRaceEffort: false })).toBeNull();
    expect(ltDanielsInputVdot(s, { now: NOW })).toBe(48);
  });

  it('a low-confidence HR fit is not running evidence: the skill cap stays', () => {
    const s = tri({ vo2: 62, hrCalibratedVdot: { vdot: 50, confidence: 'low', n: 2, r2: 0.2 } as SimulatorState['hrCalibratedVdot'] });
    expect(ltDanielsInputVdot(s, { now: NOW })).toBeCloseTo(SKILL3, 9);
  });

  it('with no fresh watch the engine fallback is replaced by the run skill rating', () => {
    // getPhysiologicalVdot falls to 'tanda-fallback', which is s.v itself.
    const low = tri({ v: 30 });
    expect(getPhysiologicalVdot(low, { now: NOW }).source).toBe('tanda-fallback');
    expect(ltDanielsInputVdot(low, { now: NOW })).toBeCloseTo(SKILL3, 9);
    const high = tri({ v: 50 });
    expect(ltDanielsInputVdot(high, { now: NOW })).toBeCloseTo(SKILL3, 9);
  });

  it('running mode reads the physiology chain unchanged', () => {
    const s = { ...getDefaultState(), vo2: 62 } as SimulatorState;
    expect(s.triConfig).toBeUndefined();
    expect(ltDanielsInputVdot(s, { now: NOW })).toBe(62);
  });

  it('HYROX reads the physiology chain unchanged', () => {
    const s = { ...getDefaultState(), eventType: 'hyrox', vo2: 62 } as SimulatorState;
    expect(ltDanielsInputVdot(s, { now: NOW })).toBe(62);
  });

  it('cycling-only mode (no run skill rating) keeps the watch without running evidence', () => {
    const s = tri({ vo2: 62, triConfig: { distance: '70.3', disciplines: ['bike'] } as SimulatorState['triConfig'] });
    expect(ltDanielsInputVdot(s, { now: NOW })).toBe(62);
  });

  it('a manual VO2max override is never capped', () => {
    const s = tri({ vo2: 62, vo2Override: { value: 60, setAt: NOW } as SimulatorState['vo2Override'] });
    expect(ltDanielsInputVdot(s, { now: NOW })).toBe(60);
  });
});

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

type RunRow = NonNullable<SimulatorState['onboardingRunHistory']>[number];
function run(daysAgo: number, km: number, sec: number): RunRow {
  const d = new Date(Date.now() - daysAgo * 86400000);
  d.setHours(9, 0, 0, 0);
  return { startTime: d.toISOString(), distKm: km, durSec: sec, activityType: 'RUNNING' };
}

function initTri(seed: Partial<SimulatorState>): void {
  resetState();
  Object.assign(getMutableState(), seed);
  expect(initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
    customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: 3 },
  } as OnboardingState).success).toBe(true);
}

function storedRunTexts(): string[] {
  return getState().wks.flatMap(w => (w.triWorkouts ?? []).filter(x => x.discipline === 'run').map(x => x.d ?? ''));
}

describe('real initializers: a cold-start triathlete runs at the skill-rating paces', () => {
  it('watch 62, run skill 3: s.lt 288 and easy 5:45/km, in the stored plan and after refreshes', () => {
    initTri({ vo2: 62 });
    expect(getState().lt).toBe(288);
    // The stored plan is written after the init's LT recompute. Pre-fix it read
    // the default s.v 50 (easy 4:59/km); live paces read s.lt 220 (4:24/km).
    const texts = storedRunTexts().filter(t => /@ \d+:\d\d\/km/.test(t));
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some(t => t.includes('@ 5:45/km'))).toBe(true);
    expect(texts.some(t => t.includes('4:59/km') || t.includes('4:24/km'))).toBe(false);
    for (let i = 0; i < 3; i++) {
      refreshBlendedFitness(getMutableState());
      expect(getState().lt).toBe(288);
      expect(triRunEasyPaceSec(getState())).toBeCloseTo(345.6, 6);
    }
    // The skill-3 easy pace the generator uses without a VDOT is 5:45/km too.
    expect(420 - (3 - 1) * 37.5).toBe(345);
  });

  it('no watch, PB or runs: s.lt holds at 288 instead of sliding to 402 s/km', () => {
    initTri({});
    const seq: number[] = [];
    for (let i = 0; i < 5; i++) {
      refreshBlendedFitness(getMutableState());
      seq.push(getState().lt!);
    }
    // Pre-fix (81d38f7): 261, 288, 319, 357, 402 as s.v fell 44.3 to 25.0.
    expect(seq).toEqual([288, 288, 288, 288, 288]);
    // The engine is held at the same figure as the LT input.
    expect(getState().v).toBeCloseTo(SKILL3, 9);
  });

  it('watch 62: the engine stays at the skill rating, with and without easy runs', () => {
    initTri({ vo2: 62 });
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBeCloseTo(SKILL3, 9);
    // Two weeks of easy runs at 6:30/km (no HR) are not a running signal and
    // do not lower it through the low-volume readiness penalties.
    const jogs: RunRow[] = [];
    for (let k = 0; k < 2; k++) jogs.push(run(2 + 7 * k, 10, 3900), run(5 + 7 * k, 8, 3120));
    initTri({ vo2: 62, onboardingRunHistory: jogs });
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBeCloseTo(SKILL3, 9);
    expect(getState().lt).toBe(288);
  });

  it('a watch below the skill rating sets the paces and holds the engine at the watch', () => {
    initTri({ vo2: 40 });
    refreshBlendedFitness(getMutableState());
    expect(getState().lt).toBe(Math.round(deriveLTFromVdot(40)!));
    // Pre-fix the engine read the blend under the readiness penalties, 35.1.
    expect(getState().v).toBeCloseTo(40, 9);
  });

  it('KNOWN LIMITATION (ISSUE-376): a synced race effort lifts the cap and the raw watch returns', () => {
    // A 10K in 48:20 (worth about 41.6) beside easy runs at 6:30/km is a race
    // effort. It lifts the cold-start cap, and a race effort is not one of the
    // running-evidence ceilings, so the LT input is the watch again. Pinned so
    // a change to the ceiling (Tristan's call) is deliberate.
    const jogs: RunRow[] = [];
    for (let k = 0; k < 2; k++) jogs.push(run(2 + 7 * k, 10, 3900), run(5 + 7 * k, 8, 3120));
    initTri({ vo2: 62, onboardingRunHistory: [run(5, 10, 2900), ...jogs] });
    refreshBlendedFitness(getMutableState());
    expect(getState().lt).toBe(220);
  });
});
