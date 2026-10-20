/**
 * HYROX race simulations (lane H2b part 2; parameter sheet sims.schedule and
 * sims.week_volume, revised), real initializer and real generator:
 *   - the planner: beginners and intermediates hold a full sim in the
 *     eligible week nearest 4 weeks before race week, half sims every 4th
 *     loaded week of build and peak; never in the race taper, a deload or
 *     before HYROX_FIRST_BRICK_WEEK; advanced athletes no full sim unless 16
 *     weeks without a race, their half sims at least 6 weeks apart;
 *   - the session: rounds of 1 km at race pace into the race's stations in
 *     order, full station volumes, the 30 s jog, a warm-up jog;
 *   - the sim week: a full sim takes the brick and long-run slots and the
 *     quality run drops, the race-pace session runs in the technique format;
 *     a half sim takes the brick slot and the quality run drops;
 *   - the 110% single-run rule turns a full sim into a half, and an injury
 *     that would drop a brick plans no sim;
 *   - a beginner's race weight starts the week before the planned full sim.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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

import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { getMutableState, resetState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';
import type { AbilityBand, HyroxStation } from '@/types/triathlon';
import { HYROX_FIRST_BRICK_WEEK } from '@/constants/hyrox-constants';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { isHyroxDeloadWeek } from './plan_engine';
import { generateHyroxPlan, hyroxSimWeeks } from './plan_engine.hyrox';
import { computeHyroxPlanPhases } from '@/constants/hyrox-constants';
import { planTrainingWeeks } from './race-week-layout';
import { generateHyroxSim } from './hyrox-generators';
import { hyroxStationRaceAmount } from './hyrox-station-dose';
import { isHighIntensity, isHardRun, isEccentricSession, isHyroxLongRun } from './scheduler.hyrox';
import { summariseHyroxSession } from '@/calculations/hyrox-session-benchmarks';

const PREV: Record<AbilityBand, number | null> = {
  total_beginner: null, beginner: 8662, novice: 6600, intermediate: 5400, advanced: 4200, competitive: 3300,
};
const FULL_ACCESS = { sled: 'always' as const, skiErg: true, rowErg: true };

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

function build(band: AbilityBand, hours: number, weeks: number, over: Partial<OnboardingState> = {}): SimulatorState {
  resetState();
  const sec = PREV[band];
  initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'hyrox',
    hyroxFormat: 'open_singles', experienceLevel: 'intermediate', triTimeAvailableHoursPerWeek: hours,
    planDurationWeeks: weeks, customRaceDate: null,
    ...(sec != null ? { previousHyroxTimeSec: sec, hyroxPreviousTimeFormat: 'open_singles' } : {}),
    ...over,
  } as OnboardingState);
  return getMutableState();
}

const prescribed = (wk: Week | undefined): Workout[] => (wk?.triWorkouts ?? []).filter(w => w.commute !== true);
const simOf = (wk: Week | undefined) => prescribed(wk).find(w => w.t === 'hyrox_sim');
const isQuality = (w: Workout) => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals';

describe('the race simulation planner', () => {
  it('beginner and intermediate: a full sim in the eligible week nearest 4 weeks before race week, half sims every 4th loaded week; never in the taper, a deload or before week 5', () => {
    for (const band of ['beginner', 'novice', 'intermediate'] as AbilityBand[]) {
      for (const len of [10, 12, 16, 18, 20, 24]) {
        const s = build(band, 6, len);
        const tw = planTrainingWeeks(s);
        const phases = computeHyroxPlanPhases(tw).map(p => p.ph);
        const sims = hyroxSimWeeks(s, tw);
        const fulls = [...sims.entries()].filter(([, v]) => v.kind === 'full').map(([w]) => w);
        expect(fulls.length, `${band} ${len}`).toBeLessThanOrEqual(1);
        const eligible = (w: number) => (phases[w - 1] === 'build' || phases[w - 1] === 'peak') && !isHyroxDeloadWeek(w, phases)
          && w >= HYROX_FIRST_BRICK_WEEK && w <= tw - 2;
        for (const [w] of sims) expect(eligible(w), `${band} ${len} W${w}`).toBe(true);
        if (fulls.length === 1) {
          // Nearest to 4 weeks before race week, ties to the earlier week.
          const target = tw - 4;
          for (let w = 1; w <= tw; w++) {
            if (!eligible(w)) continue;
            expect(Math.abs(fulls[0] - target), `${band} ${len}`).toBeLessThanOrEqual(Math.abs(w - target));
          }
        }
        // Half sims: the 4th, 8th, ... loaded week of build and peak.
        let k = 0;
        for (let w = 1; w <= tw; w++) {
          const ph = phases[w - 1];
          if ((ph !== 'build' && ph !== 'peak') || isHyroxDeloadWeek(w, phases)) continue;
          k++;
          if (sims.get(w)?.kind === 'half') expect(k % 4, `${band} ${len} W${w}`).toBe(0);
        }
      }
    }
  });

  it('advanced: no full sim by default; one about 8 weeks out after 16 weeks without a race; half sims at least 6 weeks apart', () => {
    const s = build('advanced', 10, 24);
    const tw = planTrainingWeeks(s);
    expect([...hyroxSimWeeks(s, tw).values()].some(v => v.kind === 'full')).toBe(false);
    const halves = [...hyroxSimWeeks(s, tw).entries()].filter(([, v]) => v.kind === 'half').map(([w]) => w).sort((a, b) => a - b);
    for (let i = 1; i < halves.length; i++) expect(halves[i] - halves[i - 1]).toBeGreaterThanOrEqual(6);
    // A race 30 weeks before the plan: a full sim, nearest 8 weeks before race week.
    const start = Date.parse(`${s.planStartDate}T12:00:00`);
    const old = structuredClone(s);
    old.hyroxConfig!.hyroxPreviousRaceDate = new Date(start - 30 * 7 * 86400000).toISOString().slice(0, 10);
    const full = [...hyroxSimWeeks(old, tw).entries()].find(([, v]) => v.kind === 'full')?.[0];
    expect(full).toBeDefined();
    expect(Math.abs(full! - (tw - 8))).toBeLessThanOrEqual(1);
    // A race on the plan's first day: about 15 weeks before the sim, under 16.
    const recent = structuredClone(s);
    recent.hyroxConfig!.hyroxPreviousRaceDate = s.planStartDate;
    expect([...hyroxSimWeeks(recent, tw).values()].some(v => v.kind === 'full')).toBe(false);
  });

  it('a session count that leaves no brick leaves no sim', () => {
    const s = build('intermediate', 6, 18, { hyroxWeeklySessionCount: 3 } as Partial<OnboardingState>);
    expect(hyroxSimWeeks(s, planTrainingWeeks(s)).size).toBe(0);
  });
});

describe('the race simulation session', () => {
  it('rounds of 1 km at race pace into the race\'s stations in order, full station volumes, a 30 s jog, a warm-up jog; hard, a hard run, eccentric', () => {
    const full = generateHyroxSim({ kind: 'full', band: 'intermediate', stationAccess: FULL_ACCESS, slotIndex: 1, runPaceSecKm: 330 });
    expect(full.t).toBe('hyrox_sim');
    expect(full.discipline).toBe('brick');
    expect(full.hyroxRounds).toBe(8);
    const st = (full.hyroxComponents ?? []).filter(c => c.type !== 'run');
    expect(st.map(c => c.type)).toEqual(HYROX_STATION_ORDER);
    st.forEach((c, i) => {
      expect(c.inRounds).toEqual([i + 1]);
      expect(c.raceFraction).toBe(1);
      expect(c.reps ?? c.distanceM).toBe(hyroxStationRaceAmount(c.type as HyroxStation));
    });
    expect(full.hyroxSpec?.transitionSec).toBe(30);
    expect(full.hyroxSpec?.warmup?.mode).toBe('run');
    expect(isHighIntensity(full) && isHardRun(full) && isEccentricSession(full)).toBe(true);
    expect(full.d).toMatch(/Full race simulation: 8 rounds of 1 km at HYROX race pace/);
    expect(full.d).not.toMatch(/—/);
    // A half sim: the race's first half, then its second half.
    const h0 = generateHyroxSim({ kind: 'half', halfIndex: 0, band: 'intermediate', stationAccess: FULL_ACCESS, slotIndex: 1 });
    const h1 = generateHyroxSim({ kind: 'half', halfIndex: 1, band: 'intermediate', stationAccess: FULL_ACCESS, slotIndex: 1 });
    expect((h0.hyroxComponents ?? []).filter(c => c.type !== 'run').map(c => c.type)).toEqual(HYROX_STATION_ORDER.slice(0, 4));
    expect((h1.hyroxComponents ?? []).filter(c => c.type !== 'run').map(c => c.type)).toEqual(HYROX_STATION_ORDER.slice(4));
    expect(h0.hyroxRounds).toBe(4);
  });

  it('a guided sim at race weight can teach the station benchmarks; a beginner\'s half sim at reduced loads cannot', () => {
    const s = build('intermediate', 8, 16);
    const sim = generateHyroxSim({ kind: 'half', band: 'intermediate', stationAccess: FULL_ACCESS, slotIndex: 1 });
    const records = (sim.hyroxComponents ?? []).map((c, i) => ({ exerciseIndex: i, setIndex: 0, durationSec: (c.durationSec ?? 60) * 0.98, exerciseName: String(c.type) }));
    const results = summariseHyroxSession(sim, records as never, s);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => !r.partial)).toBe(true);
    expect(results.some(r => r.eligible)).toBe(true);
    const light = generateHyroxSim({ kind: 'half', band: 'beginner', stationAccess: FULL_ACCESS, slotIndex: 1, stationLoads: { sled_push: 50, sled_pull: 37.5 } });
    const lr = summariseHyroxSession(light, (light.hyroxComponents ?? []).map((c, i) => ({ exerciseIndex: i, setIndex: 0, durationSec: c.durationSec ?? 60, exerciseName: String(c.type) })) as never, s);
    expect(lr.find(r => r.station === 'sled_push')?.eligible).toBe(false);
  });
});

describe('the race simulation week', () => {
  it('a full sim takes the brick and long-run slots and the quality run drops (the race-pace session in the technique format); a half sim takes the brick slot and the quality run drops', () => {
    let full = 0;
    let half = 0;
    for (const [band, hrs, len] of [['intermediate', 8, 18], ['novice', 6, 16], ['intermediate', 10, 20], ['advanced', 10, 20]] as Array<[AbilityBand, number, number]>) {
      const s = build(band, hrs, len);
      const tw = planTrainingWeeks(s);
      for (let i = 0; i < tw; i++) {
        const wk = s.wks[i];
        const sim = simOf(wk);
        if (!sim) continue;
        expect(prescribed(wk).some(isQuality), `${band} W${i + 1}`).toBe(false);
        expect(prescribed(wk).some(w => w.t === 'hyrox_brick' || (w.t === 'hyrox_mini_brick' && !w.hyroxLight))).toBe(false);
        if (sim.hyroxSpec?.simKind === 'full') {
          full++;
          expect(prescribed(wk).some(isHyroxLongRun)).toBe(false);
          expect(prescribed(wk).some(w => w.t === 'hyrox_station_density')).toBe(false);
        } else {
          half++;
        }
      }
    }
    expect(full).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(0);
  });

  it('the 110% single-run rule turns a full sim into a half (a beginner whose longest run is under 8 km), noted', () => {
    const s = build('beginner', 5, 16);
    const tw = planTrainingWeeks(s);
    const full = [...hyroxSimWeeks(s, tw).entries()].find(([, v]) => v.kind === 'full')?.[0];
    expect(full).toBeDefined();
    const wk = s.wks[full! - 1];
    expect(simOf(wk)?.hyroxSpec?.simKind).toBe('half');
    expect((wk.hyroxPlanNotes ?? []).some(n => /full race simulation becomes a half \(its 8 km of running above the 110% single-run ceiling/.test(n))).toBe(true);
  });

  it('a beginner\'s race weight starts the week before the planned full sim', () => {
    const s = build('beginner', 6, 16, { biologicalSex: 'female' } as Partial<OnboardingState>);
    const tw = planTrainingWeeks(s);
    const full = [...hyroxSimWeeks(s, tw).entries()].find(([, v]) => v.kind === 'full')![0];
    const loaded = (k: number) => prescribed(s.wks[k - 1]).flatMap(w => (w.hyroxComponents ?? []).filter(c => c.loadKg != null));
    expect(loaded(full - 1).every(c => c.loadPct == null)).toBe(true);
    expect(loaded(full - 1).length + loaded(full).length).toBeGreaterThan(0);
  });

  it('an injury that would drop a brick plans no sim; the week keeps its structure for the gates', () => {
    const s = build('intermediate', 8, 18);
    const tw = planTrainingWeeks(s);
    const simWeeks = [...hyroxSimWeeks(s, tw).keys()];
    expect(simWeeks.length).toBeGreaterThan(0);
    const inj = structuredClone(s);
    (inj as unknown as { injuryState: unknown }).injuryState = { active: true, runCapacity: 100, upperLoadCapacity: 50, lowerLoadCapacity: 100 };
    const wks = generateHyroxPlan(inj);
    for (const w of simWeeks) {
      expect(simOf(wks[w - 1])).toBeUndefined();
      expect((wks[w - 1].hyroxPlanNotes ?? []).some(n => /no race simulation \(injury\)/.test(n))).toBe(true);
    }
  });
});
