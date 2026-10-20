/**
 * HYROX race simulations (lane H2b part 2; parameter sheet sims.schedule and
 * sims.week_volume, revised), real initializer and real generator:
 *   - the planner: beginners and intermediates hold a full sim in the
 *     eligible week nearest 4 weeks before race week, half sims every 4th
 *     loaded week of build and peak; never in the race taper, a deload or
 *     before HYROX_FIRST_BRICK_WEEK, and never in the final 14 days before
 *     race day, by date (a Thursday to Saturday race's week before the taper
 *     holds days inside them); advanced athletes no full sim unless 16
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
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

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
import { HYROX_FIRST_BRICK_WEEK, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { isHyroxDeloadWeek } from './plan_engine';
import { generateHyroxPlan, hyroxSimWeeks } from './plan_engine.hyrox';
import { computeHyroxPlanPhases } from '@/constants/hyrox-constants';
import { planTrainingWeeks, storedPlanRaceLayout } from './race-week-layout';
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

  describe('never in the final 14 days before race day, by date', () => {
    const tz = process.env.TZ;
    afterEach(() => {
      vi.useRealTimers();
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    });
    it('Thursday to Sunday races: every sim 14 or more days out; the week before the taper keeps its sim on an earlier day (review 2026-10-20: a Saturday half sim fell 12 or 13 days before a Thursday or Friday race)', () => {
      process.env.TZ = 'Europe/London';
      let sims = 0;
      let beforeTaperThuFri = 0;
      const close: string[] = [];
      for (const onboard of ['2026-10-05T09:00:00', '2026-10-07T09:00:00']) {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(onboard));
        for (const band of ['beginner', 'novice', 'intermediate'] as AbilityBand[]) {
          for (let k = 72; k <= 168; k += 3) {
            const race = new Date(new Date(onboard).getTime() + k * 86400000).toISOString().slice(0, 10);
            const dow = (new Date(`${race}T12:00:00`).getDay() + 6) % 7;
            if (dow < 3) continue;
            const s = build(band, HYROX_HOURS_RANGE[band].default, 16, { customRaceDate: race } as Partial<OnboardingState>);
            const layout = storedPlanRaceLayout(s.tw, s.planStartDate, s.hyroxConfig!.raceDate);
            expect(layout, race).not.toBeNull();
            s.wks.forEach((wk, i) => {
              const sim = simOf(wk);
              if (!sim) return;
              sims++;
              const out = layout!.raceDayIndex - (i * 7 + (sim.dayOfWeek ?? 0));
              if (out < 14) close.push(`${band} race ${race} W${i + 1} ${sim.dayName} ${out} days out`);
              if (i + 1 === layout!.trainingWeeks - 2 && (layout!.raceDayOfWeek === 3 || layout!.raceDayOfWeek === 4)) beforeTaperThuFri++;
            });
          }
        }
        vi.useRealTimers();
      }
      expect(sims).toBeGreaterThan(80);
      expect(close).toEqual([]);
      expect(beforeTaperThuFri).toBeGreaterThan(0);
    }, 120000);
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
    // Doubles: each station is the partner's half (raceFraction 0.5, half the
    // amount and time), a partial station: it neither teaches a benchmark nor
    // takes a percentile (review 2026-10-20).
    const pair = generateHyroxSim({ kind: 'half', band: 'intermediate', stationAccess: FULL_ACCESS, slotIndex: 1, doubles: true });
    const pairSt = (pair.hyroxComponents ?? []).filter(c => c.type !== 'run');
    const solo = (sim.hyroxComponents ?? []).filter(c => c.type !== 'run');
    pairSt.forEach((c, i) => {
      expect(c.raceFraction).toBe(0.5);
      expect(c.reps ?? c.distanceM).toBe(hyroxStationRaceAmount(c.type as HyroxStation) / 2);
      expect(c.durationSec).toBeCloseTo((solo[i].durationSec ?? 0) / 2, -1);
    });
    expect(pair.d).toMatch(/your half of its race volume/);
    const pr = summariseHyroxSession(pair, (pair.hyroxComponents ?? []).map((c, i) => ({ exerciseIndex: i, setIndex: 0, durationSec: (c.durationSec ?? 60) * 0.9, exerciseName: String(c.type) })) as never, s);
    const prStations = pr.filter(r => pairSt.some(c => c.type === r.station));
    expect(prStations.length).toBeGreaterThan(0);
    expect(prStations.every(r => r.partial && !r.eligible)).toBe(true);
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

describe('a sim week keeps its station session, and beside a half sim its long run (review 2026-10-20)', () => {
  it('at low hours a sim that would cost the week either steps down (full to half to none), the week keeping its brick, and says so', () => {
    // Before, at 2 h the acute:chronic guard kept the sim (the brick slot,
    // the last to go) and dropped the station session and the long run: 7
    // weeks held the sim alone (beginner and total_beginner, 10 to 16 weeks).
    let simWeeks = 0;
    let steppedDown = 0;
    const lost: string[] = [];
    for (const band of ['total_beginner', 'beginner', 'novice'] as AbilityBand[]) {
      for (const h of [2, 3, 4]) {
        for (const len of [8, 10, 12, 16]) {
          const s = build(band, h, len);
          const tw = planTrainingWeeks(s);
          for (let i = 0; i < tw; i++) {
            const wk = s.wks[i];
            const sim = simOf(wk);
            if ((wk.hyroxPlanNotes ?? []).some(n => /race simulation.*\(it leaves the week without|the full sim leaves the week without/.test(n))) steppedDown++;
            if (!sim) continue;
            simWeeks++;
            const ws = prescribed(wk);
            const station = ws.some(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density' || w.t === 'hyrox_assessment');
            const long = sim.hyroxSpec?.simKind === 'full' || ws.some(isHyroxLongRun);
            if (!station || !long) lost.push(`${band} ${h}h ${len}w W${i + 1}: ${ws.map(w => w.n).join(', ')}`);
            // The notes name the sim, never "the chosen N sessions are full"
            // beside a week the sim's slots hold to fewer.
            for (const n of wk.hyroxPlanNotes ?? []) expect(n, `${band} ${h}h ${len}w W${i + 1}`).not.toMatch(/the chosen \d+ sessions are full/);
          }
        }
      }
    }
    expect(simWeeks).toBeGreaterThan(10);
    expect(steppedDown).toBeGreaterThan(0);
    expect(lost).toEqual([]);
  }, 120000);
});

describe('no standalone station session under 15 min (lane H2b part 2, Q11)', () => {
  it('every station session, brick, sim and strength session on the sweep runs 15 min or more (part 1: 694 of 2,109 under 15)', () => {
    // 6 bands x default hours x 12, 16 and 20 weeks x 4 variants (part 1's
    // sweep). The warm-up and the strength block open every station session,
    // and a brick opens with a jog, so the shortest is a doubles race-week
    // circuit at its warm-up and one set of two stations.
    const variants: Array<Partial<OnboardingState>> = [
      {}, { biologicalSex: 'female' } as Partial<OnboardingState>,
      { hyroxFormat: 'open_doubles' } as Partial<OnboardingState>,
      { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', biologicalSex: 'female' } as Partial<OnboardingState>,
    ];
    const short: string[] = [];
    let sessions = 0;
    for (const over of variants) {
      for (const band of ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'] as AbilityBand[]) {
        for (const len of [12, 16, 20]) {
          const s = build(band, HYROX_HOURS_RANGE[band].default, len, over);
          for (const wk of s.wks) {
            for (const w of prescribed(wk)) {
              if (!(w.discipline === 'station' || w.discipline === 'brick' || w.t === 'gym') || w.t === 'hyrox_erg_easy') continue;
              sessions++;
              if ((w.estimatedDurationMin ?? 0) < 15) short.push(`${band} ${len}w W${wk.w} ${w.n} ${w.estimatedDurationMin}`);
            }
          }
        }
      }
    }
    expect(sessions).toBeGreaterThan(2000);
    expect(short.slice(0, 10)).toEqual([]);
  }, 120000);

  it('doubles across the hours grid and plans of 8 to 24 weeks, deload, guard-held and taper weeks included: no station session or brick under 15 min (review round 2: 756 open doubles sessions at 13 to 14 min, a warm-up and one set of two stations)', () => {
    // A cut (the guard's station cut, the deload and taper caps, the phase
    // budget, the MTL cap) stops at the last round or station that keeps a
    // station session at 15 min (holdsStationFloor); the week then leaves
    // another session out, as the hierarchy orders.
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
      ['pro doubles men', { hyroxFormat: 'pro_doubles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>],
      ['7-session open doubles women', { hyroxFormat: 'open_doubles', hyroxDivision: 'women', biologicalSex: 'female', hyroxWeeklySessionCount: 7 } as Partial<OnboardingState>],
    ];
    const short: string[] = [];
    let sessions = 0;
    let deloadOrTaper = 0;
    for (const [name, over] of variants) {
      for (const band of ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'] as AbilityBand[]) {
        const r = HYROX_HOURS_RANGE[band];
        for (let h = r.min; h <= r.max; h++) {
          for (const len of [8, 10, 12, 14, 16, 18, 20, 24]) {
            const s = build(band, h, len, over);
            const phases = s.wks.map(w => w.ph);
            s.wks.forEach((wk, i) => {
              for (const w of prescribed(wk)) {
                if (!(w.discipline === 'station' || w.discipline === 'brick') || w.t === 'hyrox_erg_easy') continue;
                sessions++;
                if (wk.ph === 'taper' || isHyroxDeloadWeek(i + 1, phases)) deloadOrTaper++;
                if ((w.estimatedDurationMin ?? 0) < 15) short.push(`${name} ${band} ${h}h ${len}w W${wk.w} ${w.n} ${w.estimatedDurationMin}`);
              }
            });
          }
        }
      }
    }
    expect(sessions).toBeGreaterThan(30000);
    expect(deloadOrTaper).toBeGreaterThan(5000);
    expect(short.slice(0, 10)).toEqual([]);
  }, 300000);
});

