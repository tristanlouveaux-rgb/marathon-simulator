/**
 * Continuous (no-race) running plans deload the week the plan calls Deload.
 *
 * A continuous plan repeats a 4-week block (base, build, peak, taper) whose 4th
 * week, labelled 'taper', is shown as "Deload week. Lighter training to clear
 * fatigue." (main-view.ts getPhaseLabel). The engine keyed deloads on the
 * ability cycle instead (isDeloadWeek: every 3rd/4th/5th/6th week), which lines
 * up with the block only for intermediate runners (cycle 4):
 *   - beginner/novice (cycle 3): the Intensify week was the deload, and the
 *     labelled Deload week came out heavier than the week before it;
 *   - advanced/elite (cycle 5/6): week 5 or 6 deloaded too, two light weeks then
 *     a jump.
 * A sweep of 2,880 continuous plans found 1,158 with a Deload week heavier than
 * the week before (up to +82%).
 *
 * Fix: in continuous mode the engine deloads the block's 'taper' week and no
 * other (isRunningDeloadWeek), so the existing deload multiplier and the
 * never-heavier backstops apply to the week the UI calls Deload; the weekly load
 * target and the long-run ramp hold read the same rule.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

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

import {
  planWeekSessions, abilityBandFromVdot, isDeloadWeek, isRunningDeloadWeek,
  type PlanContext,
} from './plan_engine';
import { generateWeekWorkouts, initializeWeeks } from './generator';
import { resolvePlannedWeekPhase } from '@/calculations/planned-week-target';
import { initializeSimulator } from '@/state/initialization';
import { getState, resetState } from '@/state/store';
import type { OnboardingState } from '@/types/onboarding';
import type { RaceDistance, SimulatorState, TrainingPhase } from '@/types';
import type { Archetype } from '@/calculations/athlete-archetype';

const BLOCK: readonly TrainingPhase[] = ['base', 'build', 'peak', 'taper'];
const blockPhases = (n: number): TrainingPhase[] => Array.from({ length: n }, (_, i) => BLOCK[i % 4]);
const QUALITY = new Set(['threshold', 'vo2', 'marathon_pace', 'float']);
const NON_RUN = new Set(['cross', 'gym', 'strength', 'rest']);

describe('isRunningDeloadWeek', () => {
  it('continuous plan: the block recovery week (taper) and no other, whatever the ability', () => {
    for (const ability of ['beginner', 'novice', 'intermediate', 'advanced', 'elite'] as const) {
      const phases = blockPhases(12);
      const deloads = phases.map((ph, i) => isRunningDeloadWeek(i + 1, ability, ph, true));
      expect(deloads.map((d, i) => (d ? i + 1 : 0)).filter(Boolean), ability).toEqual([4, 8, 12]);
    }
  });

  it('race plan: the ability cycle (unchanged)', () => {
    for (const ability of ['beginner', 'novice', 'intermediate', 'advanced', 'elite'] as const) {
      for (let k = 1; k <= 16; k++) {
        expect(isRunningDeloadWeek(k, ability, 'build', false)).toBe(isDeloadWeek(k, ability));
      }
    }
  });
});

describe('continuous plans: the Deload week is never heavier than the week before', () => {
  interface Row { phase: TrainingPhase; total: number; quality: number }
  let plans: Array<{ label: string; rows: Row[] }> = [];

  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const BASES: Array<[Archetype | undefined, number | undefined]> = [
      ['consistent-runner', 25], ['high-mileage', 60], ['detrained-with-history', 15],
      ['sedentary-novice', 8], [undefined, undefined],
    ];
    const ABILITIES: Array<[string, number]> = [
      ['total_beginner', 28], ['novice', 38], ['intermediate', 45], ['advanced', 55], ['competitive', 65],
    ];
    plans = [];
    for (const rd of ['5k', '10k', 'half', 'marathon'] as RaceDistance[]) for (const N of [8, 16])
      for (const rpw of [2, 3, 5]) for (const [archetype, baselineKm] of BASES)
        for (const [fitnessLevel, vdot] of ABILITIES) for (const weeklyHoursTarget of [undefined, 3]) {
          const phases = blockPhases(N);
          const rows: Row[] = [];
          for (let k = 1; k <= N; k++) {
            const xs = planWeekSessions({
              runsPerWeek: rpw, raceDistance: rd, runnerType: 'Balanced', fitnessLevel, totalWeeks: N, vdot,
              easyPaceSecPerKm: 330, baselineKm, archetype, weeklyHoursTarget, continuousMode: true,
              planPhases: phases, weekIndex: k, phase: phases[k - 1],
            });
            rows.push({
              phase: phases[k - 1],
              total: xs.reduce((a, i) => a + i.totalMinutes, 0),
              quality: xs.filter(i => QUALITY.has(i.slot)).length,
            });
          }
          plans.push({
            label: `${rd} ${N}wk ${rpw}/wk ${archetype ?? '-'} ${baselineKm ?? '-'}km ${abilityBandFromVdot(vdot, fitnessLevel)} ${weeklyHoursTarget ?? '-'}h`,
            rows,
          });
        }
  });
  afterAll(() => { vi.restoreAllMocks(); });

  it('covers a broad sample', () => {
    expect(plans.length).toBeGreaterThan(1000);
  });

  it('no Deload week is heavier, or carries more quality sessions, than the week before', () => {
    const bad: string[] = [];
    for (const { label, rows } of plans) {
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].phase !== 'taper') continue;
        if (rows[i].total > rows[i - 1].total || rows[i].quality > rows[i - 1].quality) {
          bad.push(`${label} wk${i + 1}: ${rows[i - 1].total}/${rows[i - 1].quality}q -> ${rows[i].total}/${rows[i].quality}q`);
        }
      }
    }
    expect(bad.slice(0, 10), `${bad.length} Deload weeks heavier than the week before`).toEqual([]);
  });
});

describe('continuous plans: the weekly load target deloads the same week', () => {
  afterEach(() => resetState());

  const state = (v: number, experienceLevel: string): SimulatorState => {
    const wks = initializeWeeks(8);
    blockPhases(8).forEach((ph, i) => { wks[i].ph = ph; });
    return {
      wks, w: 1, v, rw: 4, rd: '10k', continuousMode: true, onboarding: { experienceLevel },
    } as unknown as SimulatorState;
  };

  for (const [label, v, level] of [['novice', 38, 'novice'], ['intermediate', 45, 'intermediate'], ['advanced', 55, 'advanced']] as const) {
    it(`${label}: the Intensify week targets its own phase, the Deload week a deload`, () => {
      const s = state(v, level);
      expect(resolvePlannedWeekPhase(s, 3).phase).toBe('peak');
      expect(resolvePlannedWeekPhase(s, 4).phase).toBe('deload');
      expect(resolvePlannedWeekPhase(s, 5).phase).toBe('base');
      expect(resolvePlannedWeekPhase(s, 6).phase).toBe('build');
    });
  }
});

describe('continuous plan, real path (initializeSimulator then generateWeekWorkouts)', () => {
  afterEach(() => { resetState(); localStorageMock.clear(); vi.restoreAllMocks(); });

  function runMinutesByWeek(onboarding: Partial<OnboardingState>, weeks: number): number[] {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetState();
    const res = initializeSimulator({
      trainingMode: 'running', trainingForEvent: false, planDurationWeeks: 8, pbs: {}, ...onboarding,
    } as OnboardingState);
    expect(res.success).toBe(true);
    const s = getState();
    expect(s.continuousMode).toBe(true);
    const out: number[] = [];
    for (let k = 1; k <= weeks; k++) {
      const wk = s.wks[k - 1];
      const ws = generateWeekWorkouts(
        wk.ph, s.rw, s.rd, s.typ, [], undefined, null, undefined,
        s.onboarding?.experienceLevel, undefined, s.pac?.e, k, s.tw, s.v, 0,
        undefined, undefined, undefined, s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
      );
      out.push(ws.filter(w => !NON_RUN.has(w.t)).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0));
    }
    return out;
  }

  it('beginner, 5K focus, 5 runs: the Deload week is lighter than the Build and Intensify weeks', () => {
    const mins = runMinutesByWeek({ experienceLevel: 'beginner', trainingFocus: 'speed', runsPerWeek: 5 }, 4);
    expect(getState().wks.slice(0, 4).map(w => w.ph)).toEqual(['base', 'build', 'peak', 'taper']);
    expect(mins[3], `weeks ${mins.join(', ')}`).toBeLessThan(mins[2]);
    expect(mins[3], `weeks ${mins.join(', ')}`).toBeLessThan(mins[1]);
  });

  it('advanced, endurance focus, 4 runs: the week after Deload is not a second light week', () => {
    const mins = runMinutesByWeek({
      experienceLevel: 'advanced', trainingFocus: 'endurance', runsPerWeek: 4, pbs: { k5: 1080, k10: 2250 },
    } as Partial<OnboardingState>, 6);
    expect(mins[3], `weeks ${mins.join(', ')}`).toBeLessThan(mins[2]);
    expect(mins[4], `weeks ${mins.join(', ')}`).toBeGreaterThan(mins[3]);
  });
});

describe('race plans keep the ability-cycle deload', () => {
  it('a race-plan build week on the ability cycle is still a deload week in the engine', () => {
    const ctx = (k: number): PlanContext => ({
      runsPerWeek: 4, raceDistance: 'half', runnerType: 'Balanced', fitnessLevel: 'novice', totalWeeks: 12,
      vdot: 38, weekIndex: k, phase: 'build',
    });
    // Novice cycle 3: week 6 is a deload, its sessions carry the deload note.
    expect(planWeekSessions(ctx(6)).some(i => i.notes === 'Deload week')).toBe(true);
    expect(planWeekSessions(ctx(5)).some(i => i.notes === 'Deload week')).toBe(false);
  });

  it('a continuous Intensify week on the ability cycle no longer carries the deload note', () => {
    const phases = blockPhases(8);
    const ctx = (k: number): PlanContext => ({
      runsPerWeek: 4, raceDistance: 'half', runnerType: 'Balanced', fitnessLevel: 'novice', totalWeeks: 8,
      vdot: 38, weekIndex: k, phase: phases[k - 1], continuousMode: true, planPhases: phases,
    });
    expect(planWeekSessions(ctx(3)).some(i => i.notes === 'Deload week')).toBe(false);
    expect(planWeekSessions(ctx(4)).some(i => i.notes === 'Deload week')).toBe(true);
  });
});
