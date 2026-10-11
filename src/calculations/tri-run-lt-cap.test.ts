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
  ltDanielsInputVdot, resolveLtDanielsInput, getPhysiologicalVdot, triColdStartRunCapVdot, effectiveVo2max, pbMedianVdot,
  triathleteRunEvidenceCeiling, triRunEvidenceRaceEffort,
} from './physiological-vdot';
import { runSkillVdot, estimateRunPaceFromSkill } from './tri-run-skill';
import { deriveLTFromVdot } from './lt-derivation';
import { cv } from './vdot';
import { recomputeLT } from '@/data/ltSync';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { getDefaultState, getMutableState, getState, resetState } from '@/state/store';
import { refreshBlendedFitness } from './blended-fitness';
import { triRunEasyPaceSec } from '@/workouts/tri-run-pace';
import { predictTriathlonRace } from './race-prediction.triathlon';
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
    expect(triColdStartRunCapVdot(s)).toBeCloseTo(SKILL3, 9);
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

  it('coldStartCapped is true only where the cap replaced the input', () => {
    // Watch above the skill rating: replaced by the skill VDOT.
    expect(resolveLtDanielsInput(tri({ vo2: 62 }), { now: NOW })).toEqual({ vdot: SKILL3, coldStartCapped: true, source: 'device', uncappedVdot: 62 });
    // Watch at or below it: used as it is, not capped.
    expect(resolveLtDanielsInput(tri({ vo2: 40 }), { now: NOW })).toEqual({ vdot: 40, coldStartCapped: false, source: 'device', uncappedVdot: 40 });
    expect(resolveLtDanielsInput(tri({ vo2: SKILL3 }), { now: NOW }).coldStartCapped).toBe(false);
    // No fresh watch (engine fallback): replaced by the skill VDOT.
    expect(resolveLtDanielsInput(tri({ v: 30 }), { now: NOW })).toEqual({ vdot: SKILL3, coldStartCapped: true, source: 'tanda-fallback', uncappedVdot: 30 });
    // Running evidence: the ceiling applies, which is not the cold-start cap.
    expect(resolveLtDanielsInput(tri({ vo2: 62, pbs: { k10: 3000 } }), { now: NOW }).coldStartCapped).toBe(false);
    // Running mode: never.
    expect(resolveLtDanielsInput({ ...getDefaultState(), vo2: 62 } as SimulatorState, { now: NOW }).coldStartCapped).toBe(false);
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
    expect(triColdStartRunCapVdot(s)).toBeNull();
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

function initTri(seed: Partial<SimulatorState>, runSkill: 1 | 2 | 3 | 4 | 5 = 3): void {
  resetState();
  Object.assign(getMutableState(), seed);
  expect(initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
    customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: runSkill },
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

  it('a watch below the skill rating sets the paces and leaves the engine to the blend, as before', () => {
    // The watch is not capped (it reads below the skill rating), so the LT
    // input and the engine are what they were at 81d38f7: no cold-start hold.
    // A hold here raised the engine to the watch (35.1 to 40.0 in 85c1ea4) and
    // sped up the 70.3 run leg by 13 min with no change to the paces (review
    // 2026-10-09).
    initTri({ vo2: 40 });
    refreshBlendedFitness(getMutableState());
    expect(getState().lt).toBe(Math.round(deriveLTFromVdot(40)!));
    expect(resolveLtDanielsInput(getState(), {}).coldStartCapped).toBe(false);
    expect(getState().v).toBeCloseTo(35.1, 1);
    // Watches 36 and 43 (both below 44.3) also read the blend, not the watch
    // (85c1ea4 held them at exactly 36.00 and 43.00).
    for (const [vo2, v] of [[36, 31.4], [43, 38.1]] as const) {
      initTri({ vo2 });
      refreshBlendedFitness(getMutableState());
      expect(getState().v).toBeCloseTo(v, 1);
    }
  });

  it('a watch just above the skill rating keeps the 81d38f7 engine: no step at the boundary', () => {
    // Where the cap lowers a watch-derived LT input, the engine is what the
    // blend gives with the LT from the uncapped watch, capped at the skill
    // VDOT: the 81d38f7 engine. Run skill 5 (55.8) caps nothing below 55.8,
    // so its engine is the uncapped blend, which is 81d38f7's figure before
    // its skill cap. 5a255db held every watch above 44.3 at 44.3: watch 44.3
    // read 39.35 and 44.4 read 44.31, a 4.96 VDOT step for 0.1 on the watch,
    // with the 70.3 run leg 12.5 min faster (review 2026-10-09).
    const engine: Record<number, number> = {};
    const runLeg: Record<number, number> = {};
    for (const vo2 of [44.3, 44.4, 46, 48, 50, 62]) {
      initTri({ vo2 });
      refreshBlendedFitness(getMutableState());
      engine[vo2] = getState().v!;
      runLeg[vo2] = predictTriathlonRace(getMutableState())!.runSec;
      // The paces follow the capped figure whatever the engine reads.
      expect(getState().lt).toBe(288);
      if (vo2 >= 50) continue;
      initTri({ vo2 }, 5);
      refreshBlendedFitness(getMutableState());
      expect(engine[vo2]).toBeCloseTo(getState().v!, 6);
    }
    expect(engine[44.3]).toBeCloseTo(39.35, 2);
    expect(engine[44.4]).toBeCloseTo(39.37, 2);
    expect(engine[46]).toBeCloseTo(40.91, 2);
    expect(engine[48]).toBeCloseTo(42.97, 2);
    // Continuity across the boundary, in the engine and in the run leg.
    expect(Math.abs(engine[44.4] - engine[44.3])).toBeLessThan(0.05);
    expect(Math.abs(runLeg[44.4] - runLeg[44.3])).toBeLessThan(10);
    // A watch far above the rating still reads the skill VDOT, as at 81d38f7.
    expect(engine[50]).toBeCloseTo(SKILL3, 9);
    expect(engine[62]).toBeCloseTo(SKILL3, 9);
    // The engine rises with the watch and never passes the skill VDOT.
    const seq = [44.3, 44.4, 46, 48, 50, 62].map(v => engine[v]);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
      expect(seq[i]).toBeLessThanOrEqual(SKILL3 + 1e-9);
    }
  });

  it('ISSUE-376: a synced race effort lifts the cap and the watch is held at the race, not the raw 62', () => {
    // A 10K in 48:20 (worth about 41.6) beside easy runs at 6:30/km is a race
    // effort (no HR zones here, so the pace test stands). It lifts the
    // cold-start cap and, since 2026-10-11, is one of the running-evidence
    // ceilings. Before, the LT input was the watch again (s.lt 220).
    const jogs: RunRow[] = [];
    for (let k = 0; k < 2; k++) jogs.push(run(2 + 7 * k, 10, 3900), run(5 + 7 * k, 8, 3120));
    initTri({ vo2: 62, onboardingRunHistory: [run(5, 10, 2900), ...jogs] });
    refreshBlendedFitness(getMutableState());
    expect(ltDanielsInputVdot(getState())).toBeCloseTo(cv(10000, 2900), 9);
    expect(getState().lt).toBe(Math.round(deriveLTFromVdot(cv(10000, 2900))!));
    expect(getState().lt).not.toBe(220);
  });
});

/**
 * ISSUE-376 (Tristan, 2026-10-11): a synced race effort lifts the cold-start
 * cap, and it was not in the running-evidence ceiling, so the raw watch came
 * back into s.lt (70.3, watch 62, run skill 3, three weeks of jogs plus an
 * 8 km run at 5:00/km with no HR: s.lt 288 to 220, the run leg 17 min faster).
 * The race effort's own VDOT is now in the ceiling, and where HR rules exist a
 * run with no HR is not evidence at all.
 */
describe('real initializers: a synced race effort is running evidence the watch is held to', () => {
  const HR = { maxHR: 190, restingHR: 50 };
  const jogs = (): RunRow[] => {
    const rows: RunRow[] = [];
    for (let k = 0; k < 3; k++) rows.push(run(2 + 7 * k, 10, 3900), run(5 + 7 * k, 8, 3120));
    return rows;
  };
  const effort = (avgHR?: number): RunRow => ({ ...run(1, 8, 2400), ...(avgHR != null ? { avgHR } : {}) });
  const EFFORT_VDOT = cv(8000, 2400);

  it('an 8 km run at 5:00/km at a race-level HR lifts the cap and holds the watch at its own VDOT', () => {
    initTri({ vo2: 62, ...HR, onboardingRunHistory: [effort(175), ...jogs()] });
    refreshBlendedFitness(getMutableState());
    const s = getState();
    expect(triRunEvidenceRaceEffort(s)).toMatchObject({ d: 8, t: 2400 });
    expect(triColdStartRunCapVdot(s)).toBeNull();
    expect(triathleteRunEvidenceCeiling(s)).toBeCloseTo(EFFORT_VDOT, 9);
    // The LT input and the blend's VO2 predictor: the watch at the run's VDOT,
    // not the raw 62 (s.lt 220 before).
    expect(ltDanielsInputVdot(s)).toBeCloseTo(EFFORT_VDOT, 9);
    expect(effectiveVo2max(s)).toBeCloseTo(EFFORT_VDOT, 9);
    expect(s.lt).toBe(Math.round(deriveLTFromVdot(EFFORT_VDOT)!));
    expect(s.lt).toBeGreaterThan(288);
  });

  it('the same run with no HR is not evidence where HR rules exist: the cold-start cap holds', () => {
    initTri({ vo2: 62, ...HR, onboardingRunHistory: [effort(), ...jogs()] });
    refreshBlendedFitness(getMutableState());
    const s = getState();
    expect(triRunEvidenceRaceEffort(s)).toBeNull();
    expect(triColdStartRunCapVdot(s)).toBeCloseTo(SKILL3, 9);
    expect(s.lt).toBe(288);
    expect(s.v).toBeCloseTo(SKILL3, 9);
  });

  it('a tempo at a steady-tempo HR is not evidence either', () => {
    initTri({ vo2: 62, ...HR, onboardingRunHistory: [effort(165), ...jogs()] });
    refreshBlendedFitness(getMutableState());
    const s = getState();
    expect(triRunEvidenceRaceEffort(s)).toBeNull();
    expect(triColdStartRunCapVdot(s)).toBeCloseTo(SKILL3, 9);
    // The Daniels input stays at the skill rating. (s.lt also reads the
    // empirical method: this 40-min run with HR is a sustained effort.)
    expect(ltDanielsInputVdot(s)).toBeCloseTo(SKILL3, 9);
    expect(s.v).toBeLessThanOrEqual(SKILL3 + 1e-9);
  });

  it('with no HR zones at all the pace test stands alone, and the watch is held at the run', () => {
    initTri({ vo2: 62, onboardingRunHistory: [effort(), ...jogs()] });
    refreshBlendedFitness(getMutableState());
    const s = getState();
    expect(triRunEvidenceRaceEffort(s)).toMatchObject({ d: 8, t: 2400 });
    expect(triColdStartRunCapVdot(s)).toBeNull();
    expect(ltDanielsInputVdot(s)).toBeCloseTo(EFFORT_VDOT, 9);
    expect(s.lt).toBe(Math.round(deriveLTFromVdot(EFFORT_VDOT)!));
    expect(s.lt).not.toBe(220);
  });

  it('running mode: a race effort never sets a ceiling (no triConfig)', () => {
    const s = { ...getDefaultState(), vo2: 62, ...HR, onboardingRunHistory: [effort(175), ...jogs()] } as SimulatorState;
    expect(triathleteRunEvidenceCeiling(s)).toBeNull();
    expect(effectiveVo2max(s)).toBe(62);
  });
});
