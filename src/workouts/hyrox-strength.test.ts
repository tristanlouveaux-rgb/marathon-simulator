/**
 * HYROX strength in the plan (lane H2b part 2 review, 2026-10-20), real
 * initializer and real generator:
 *   - strength (the station sessions' blocks, then the standalone session)
 *     takes only the minutes the week's limits leave once its runs and
 *     station work are sized, so no training week loses its running to it
 *     (parameter sheet split.running_share: running is 40% of the weekly
 *     hours, the other 60% holds the station session, strength and brick
 *     station work). Before, 20 of 1,340 training weeks held no running and
 *     62 of 75 beginner base weeks ran under 0.40 of the week (part 1: 0 and
 *     35);
 *   - a week holds no more strength than the sheet's count
 *     (HYROX_STRENGTH_SESSIONS), the week before race week at most the light
 *     block, race week none, a deload no standalone session;
 *   - the standalone session takes its own day, never repeats its week's
 *     block, and a template session runs its content's 20 min;
 *   - under a partial station capacity a station session keeps the
 *     combination of its rounds and stations with the most station work
 *     within the capacity's share of its own (the smallest when none is
 *     that small), keeps its warm-up and runs 15 min or more, singles and
 *     doubles (review round 3); under a one-sided restriction it cuts the
 *     restricted side's stations first and holds that side's share too, and
 *     a jog warm-up follows the run capacity (review round 4); it keeps the
 *     most restricted-side work within the shares, so that work never falls
 *     as the capacity rises, holds each of two unequally restricted sides to
 *     its own share, and its warm-up moves off the restricted side or keeps
 *     the restricted capacity's share (review round 5); a restricted side's
 *     single set keeps its capacity's share of that set, equal restrictions
 *     hold each side to its own share, the warm-up takes the way with the
 *     highest capacity of its own (the Row Erg full-body), and with no
 *     warm-up left round 1 at easy effort is written into the session (review
 *     round 6); with no shape within the shares that holds the 15-min floor
 *     it leaves the week, every set of a restricted side's station keeps its
 *     capacity's share, two restricted sides take every cut order, the floor
 *     counts the planned 10-min warm-up (after round 1 when round 1 is the
 *     warm-up, so a one-round session leaves), the warm-up keeps its share at
 *     equal capacities too, round 1 as the warm-up prices its planned TSS at
 *     the easy RPE, and no kept session leaves as a capacity rises (review
 *     round 7).
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
import {
  HYROX_HOURS_RANGE, HYROX_WEEKLY_STRUCTURE, HYROX_STRENGTH_SESSIONS, HYROX_RUN_SHARE, HYROX_RUN_FLOOR_MIN,
  HYROX_STRENGTH_BLOCK_MIN, hyroxTier, hyroxBaseMultiplier,
} from '@/constants/hyrox-constants';
import { isHyroxDeloadWeek } from './plan_engine';
import { generateHyroxPlanDetailed, regenerateHyroxWeeksFrom, applyHyroxInjuryGates, holdsStationFloor } from './plan_engine.hyrox';
import { hyroxSessionWorkMin, withHyroxRounds, hyroxRunLengthKm, withoutHyroxStation, hyroxStationToCut, withHyroxFinisher, withHyroxSessionParts, withHyroxPartialSets, hyroxWarmupOn } from './hyrox-generators';
import { hyroxSessionWalk, hyroxComponentSets, hyroxSessionPlannedTss } from './hyrox-session-shape';
import { plannedTssPerMin } from '@/constants/sports';
import { HYROX_EASY_RPE } from '@/constants/hyrox-constants';
import { HYROX_STATION_REGION } from '@/calculations/hyrox-injury';
import type { InjuryState } from '@/types/injury';
import { planTrainingWeeks } from './race-week-layout';
import { isHyroxLongRun, isHyroxStrengthSession } from './scheduler.hyrox';

const BANDS: AbilityBand[] = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'];
const PREV: Record<AbilityBand, number | null> = {
  total_beginner: null, beginner: 8662, novice: 6600, intermediate: 5400, advanced: 4200, competitive: 3300,
};

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
const isQuality = (w: Workout) => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals';
/** Running as the share counts it: standalone runs plus the run components
 *  of station, brick and sim sessions. */
const runningMin = (ws: readonly Workout[]) => ws.reduce((a, w) => a + (w.discipline === 'run'
  ? (w.estimatedDurationMin ?? 0)
  : (w.hyroxComponents ?? []).filter(c => c.type === 'run').reduce((b, c) => b + ((c.durationSec ?? 0) * (w.hyroxRounds ?? 1)) / 60, 0)), 0);
/** One station's work in `g` as a share of its work in `u` (work seconds). */
const sideShareOf = (u: Workout, g: Workout, st: HyroxStation) => {
  const sec = (w: Workout) => hyroxSessionWalk(w).filter(x => x.component.type === st).reduce((a, x) => a + (x.component.durationSec ?? 0), 0);
  return sec(u) > 0 ? sec(g) / sec(u) : 0;
};
const blocksOf = (ws: readonly Workout[]) => ws.filter(w => !!w.hyroxSpec?.strength);
const standaloneOf = (ws: readonly Workout[]) => ws.filter(w => isHyroxStrengthSession(w));
/** The bands' hours grid: the lowest, 3 to 6 h and the default. */
const hoursGrid = (band: AbilityBand) => {
  const r = HYROX_HOURS_RANGE[band];
  return [r.min, 3, 4, 5, 6, r.default].filter((h, i, a) => a.indexOf(h) === i && h >= r.min && h <= r.max).sort((a, b) => a - b);
};

/** Work seconds of a session's stations on one side (0 for none). */
const sideSecOf = (w: Workout | undefined, side: 'upper' | 'lower') => (w ? hyroxSessionWalk(w)
  .filter(x => x.component.type !== 'run' && HYROX_STATION_REGION[x.component.type as HyroxStation] === side)
  .reduce((a, x) => a + (x.component.durationSec ?? 0), 0) : 0);
const sigOf = (w: Workout | undefined) => (w ? `${(w.hyroxComponents ?? []).map(c => `${c.type}${c.raceFraction != null && c.raceFraction < 0.25 - 1e-9 ? '(part)' : ''}`).join('+')} x${w.hyroxRounds}` : 'left out');

/** The 15-min station floor, an independent copy (review round 7): the
 *  station work with the planned 10-min warm-up, whatever the gates left of
 *  the warm-up; with round 1 as the warm-up, the station work after round 1. */
const floorHolds = (c: Workout) => {
  const roundOne = c.hyroxSpec?.warmupRound ? hyroxSessionWalk(c).filter(x => x.round === 1).reduce((a, x) => a + (x.component.durationSec ?? 0) + x.restSec + x.transitionSec, 0) / 60 : 0;
  return Math.round(hyroxSessionWorkMin(c) - roundOne + 10) >= 15;
};

/**
 * The injury gate's station-session choice, an independent copy of the rule
 * (review rounds 3 to 8), for a session whose warm-up keeps its 10 min (run
 * capacity 100 with both ergs: the warm-up moves to a jog or the free erg
 * whole). Candidates: every shape of the cut walk in each of three orders
 * (both sides' stations first, the lower body's first, the upper body's
 * first; the full-body stations between; down to MIN_CIRCUIT_STATIONS
 * stations and one round), whichever sides are restricted; and every shape of
 * the partial walk (the full-body stations, then an unrestricted side's; a
 * restricted side's stay) three ways: each side in turn pinned at the station
 * capacity's share with the other side's sets (a side at 100 included) at
 * the largest share that fits, at most its own capacity's, the full-body sets
 * whole and then at the station share; and both sides at the station share
 * with the full-body sets at the largest share that fits, at most the
 * station share (sets round down to a whole metre or rep). A candidate fits
 * when its station work is at or under the station capacity's share and each
 * restricted side's at or under its own. The session keeps, of the fits that
 * hold the station floor (floorHolds), the most work on each side (lowest
 * capacity first, the lower body first at a tie, a side at 100 too), then
 * the most station work; with none it leaves the week.
 */
function gateRule(u: Workout, upper: number, lower: number, access: NonNullable<SimulatorState['hyroxConfig']>['stationAccess']): Workout | undefined {
  const capOf = { upper, lower } as const;
  const stationCap = Math.min(upper, lower);
  const share = stationCap / 100;
  const sides = (['lower', 'upper'] as const).filter(r => capOf[r] < 100);
  const order = (['lower', 'upper'] as const).slice().sort((a, b) => capOf[a] - capOf[b]);
  const low: 'upper' | 'lower' | null = upper < lower ? 'upper' : lower < upper ? 'lower' : null;
  const restrictedSt = (st: HyroxStation) => { const r = HYROX_STATION_REGION[st]; return r !== 'full' && capOf[r] < 100; };
  const rankFirst = (first: 'upper' | 'lower' | null) => (st: HyroxStation) => { const r = HYROX_STATION_REGION[st]; return r === 'full' ? 1 : first == null || r === first ? 0 : 2; };
  const s0 = withHyroxSessionParts(withHyroxFinisher(u, 0, access, 0), { strength: null });
  const target = (stationCap / 100) * hyroxSessionWorkMin(u);
  const walk = (rk: (st: HyroxStation) => number, stop?: (st: HyroxStation) => boolean): Workout[] => {
    const out: Workout[] = [];
    for (let st = s0; ;) {
      for (let r = st.hyroxRounds ?? 1; r >= 1; r--) out.push(withHyroxRounds(st, r));
      const cut = hyroxStationToCut(st, rk);
      if (!cut || stop?.(cut)) break;
      const next = withoutHyroxStation(st, cut);
      if (next === st) break;
      st = next;
    }
    return out;
  };
  const whole = ([null, 'lower', 'upper'] as const).flatMap(first => walk(rankFirst(first)));
  const partial: Workout[] = [];
  const regionOf = (st: HyroxStation) => HYROX_STATION_REGION[st];
  for (const c of walk(st => (restrictedSt(st) ? 3 : rankFirst(low)(st)), restrictedSt)) {
    const rounds = c.hyroxRounds ?? 1;
    const setSec = (region: string) => (c.hyroxComponents ?? []).reduce((a, x) => a + (x.type !== 'run' && regionOf(x.type as HyroxStation) === region ? (x.durationSec ?? 0) * hyroxComponentSets(x, rounds) : 0), 0);
    const make = (fixed: (st: HyroxStation) => number | null, fill: 'upper' | 'lower' | 'full', cap: number) => {
      let f: number | null = null;
      if (setSec(fill) > 0) {
        // The work with the fill sets at no time, the rest at their shares.
        const zeroed = withHyroxPartialSets(c, fixed);
        const rest = hyroxSessionWorkMin({ ...zeroed, hyroxComponents: (zeroed.hyroxComponents ?? []).map(x => (x.type !== 'run' && regionOf(x.type as HyroxStation) === fill ? { ...x, durationSec: 0 } : x)) });
        if (target - rest <= 0) return;
        f = Math.min(cap, ((target - rest) * 60) / setSec(fill));
      }
      const p = withHyroxPartialSets(c, st => (regionOf(st) === fill ? f : fixed(st)));
      if (p !== c) partial.push(p);
    };
    for (const pinned of ['upper', 'lower'] as const) {
      const free = pinned === 'upper' ? 'lower' : 'upper';
      make(st => (regionOf(st) === pinned ? share : null), free, capOf[free] / 100);
      make(st => (regionOf(st) === pinned || regionOf(st) === 'full' ? share : null), free, capOf[free] / 100);
    }
    make(st => (regionOf(st) === 'full' ? null : share), 'full', share);
  }
  const fits = (c: Workout) => hyroxSessionWorkMin(c) <= target + 1e-6
    && sides.every(r => sideSecOf(c, r) <= (capOf[r] / 100) * sideSecOf(u, r) + 1e-6);
  const key = (c: Workout) => [...order.map(r => sideSecOf(c, r)), hyroxSessionWorkMin(c) * 60];
  const above = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) { if (a[i] > b[i] + 1e-6) return true; if (a[i] < b[i] - 1e-6) return false; } return false; };
  const keep = [...whole, ...partial].filter(c => fits(c) && floorHolds(c));
  return keep.length > 0 ? keep.reduce((a, c) => (above(key(c), key(a)) ? c : a)) : undefined;
}
/** Within the station capacity's share and each restricted side's. */
const withinShares = (u: Workout, g: Workout, upper: number, lower: number) => hyroxSessionWorkMin(g) <= (Math.min(upper, lower) / 100) * hyroxSessionWorkMin(u) + 1e-6
  && (upper >= 100 || sideSecOf(g, 'upper') <= (upper / 100) * sideSecOf(u, 'upper') + 1e-6)
  && (lower >= 100 || sideSecOf(g, 'lower') <= (lower / 100) * sideSecOf(u, 'lower') + 1e-6);

describe('strength takes only the minutes the week leaves after its runs and station work', () => {
  it('no training week holds no running (review 2026-10-20: 20 of 1,340 did, every non-advanced band at 2 h, week 4)', () => {
    const none: string[] = [];
    let weeks = 0;
    for (const band of BANDS) {
      for (const h of hoursGrid(band)) {
        for (const len of [10, 12, 16, 20]) {
          const s = build(band, h, len);
          const tw = planTrainingWeeks(s);
          for (let i = 0; i < tw - 2; i++) {
            const ws = prescribed(s.wks[i]);
            weeks++;
            if (runningMin(ws) <= 0) none.push(`${band} ${h}h ${len}w W${i + 1}: ${ws.map(w => w.n).join(', ')}`);
          }
        }
      }
    }
    expect(weeks).toBeGreaterThan(1000);
    expect(none.slice(0, 10)).toEqual([]);
  }, 120000);

  it('a base week holding strength runs what the running share funds, up to what its run slots hold (review: beginner base weeks under 0.40 of the week as running, 62 of 75)', () => {
    // The running share of the week's size (HYROX_RUN_SHARE x the size: the
    // chosen hours unless the acute:chronic guard sizes the week smaller),
    // up to what its run slots hold: the long run, the quality run and each
    // easy run at most the long run. An easy run the share would fund under
    // the run floor is not prescribed (one HYROX_RUN_FLOOR_MIN of slack). A
    // week the MTL cap trims is left out (the cap cuts easy running whatever
    // strength the week holds: strength carries no MTL).
    const short: string[] = [];
    let checked = 0;
    for (const band of BANDS) {
      const tier = hyroxTier(band);
      for (const h of hoursGrid(band)) {
        for (const len of [12, 16, 20]) {
          const s = build(band, h, len);
          const { detail } = generateHyroxPlanDetailed(s);
          const phases = s.wks.map(w => w.ph);
          for (const d of detail) {
            if (d.phase !== 'base' || d.deload || isHyroxDeloadWeek(d.week, phases)) continue;
            const ws = prescribed({ triWorkouts: d.workouts } as Week);
            if (blocksOf(ws).length + standaloneOf(ws).length === 0) continue;
            if (d.adjustments.some(n => /MTL cap \d+/.test(n))) continue;
            const size = d.budgetMin / hyroxBaseMultiplier(d.week);
            const long = ws.find(isHyroxLongRun)?.estimatedDurationMin ?? 0;
            const q = ws.filter(isQuality).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
            const slots = HYROX_WEEKLY_STRUCTURE[tier].base.runs;
            const easySlots = Math.max(0, slots - (long > 0 ? 1 : 0) - (q > 0 ? 1 : 0));
            const capacity = long + q + easySlots * long;
            const expected = Math.min(HYROX_RUN_SHARE * size, capacity) - HYROX_RUN_FLOOR_MIN;
            checked++;
            if (runningMin(ws) < expected - 1e-6) short.push(`${band} ${h}h ${len}w W${d.week}: running ${runningMin(ws).toFixed(0)} under ${expected.toFixed(0)} with ${ws.map(w => `${w.n} ${w.estimatedDurationMin}`).join(', ')}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(short.slice(0, 10)).toEqual([]);
  }, 120000);
});

describe('strength counts and sessions', () => {
  it('no week holds more strength than the sheet\'s count; the week before race week at most the light block; race week none; a deload no standalone session', () => {
    const over: string[] = [];
    let held = 0;
    for (const band of BANDS) {
      const tier = hyroxTier(band);
      for (const h of hoursGrid(band)) {
        for (const len of [10, 16, 20]) {
          const s = build(band, h, len);
          const tw = planTrainingWeeks(s);
          const phases = s.wks.slice(0, tw).map(w => w.ph);
          for (let i = 0; i < tw; i++) {
            const wk = s.wks[i];
            const ws = prescribed(wk);
            const blocks = blocksOf(ws);
            const standalone = standaloneOf(ws);
            const n = blocks.length + standalone.length;
            held += n;
            const label = `${band} ${h}h ${len}w W${i + 1}`;
            if (i + 1 === tw) { if (n > 0) over.push(`${label}: race week holds ${n}`); continue; }
            if (i + 1 === tw - 1) {
              if (n > 1 || standalone.length > 0 || blocks.some(b => !b.hyroxSpec?.strength?.light)) over.push(`${label}: the week before race week holds ${n}, not 1 light block`);
              continue;
            }
            const ph = wk.ph as 'base' | 'build' | 'peak';
            if (n > HYROX_STRENGTH_SESSIONS[tier][ph]) over.push(`${label}: ${n} above the sheet's ${HYROX_STRENGTH_SESSIONS[tier][ph]} (${ph})`);
            if (isHyroxDeloadWeek(i + 1, phases) && standalone.length > 0) over.push(`${label}: a deload holds the standalone session`);
          }
        }
      }
    }
    expect(held).toBeGreaterThan(500);
    expect(over.slice(0, 10)).toEqual([]);
  }, 120000);

  it('the week before race week holds its light block, from the spare minutes, the finishers and running above its floors, inside 0.55 (review round 2: 12 of 96 no-race plans held it, 3 of 24 at the default hours)', () => {
    // Sheet strength.sessions and taper.content: one light strength session
    // in the week before race week. Left out only when its station session
    // is missing, the 48 h rule forbids it, or every easy run is at the run
    // floor and the long run no longer than the week's longest other run
    // (the light block outranks easy running above its floors).
    let plans = 0;
    let held = 0;
    let heldDefault = 0;
    let plansDefault = 0;
    const wrong: string[] = [];
    for (const band of BANDS) {
      const r = HYROX_HOURS_RANGE[band];
      for (const h of [r.min, Math.round((r.min + r.default) / 2), r.default, r.max].filter((x, i, a) => a.indexOf(x) === i)) {
        for (const len of [12, 16, 20, 24]) {
          const s = build(band, h, len);
          const tw = planTrainingWeeks(s);
          const wk = s.wks[tw - 2];
          const ws = prescribed(wk);
          plans++;
          if (h === r.default) plansDefault++;
          const label = `${band} ${h}h ${len}w W${tw - 1}`;
          if (blocksOf(ws).some(w => !!w.hyroxSpec?.strength?.light)) {
            held++;
            if (h === r.default) heldDefault++;
            continue;
          }
          const note = (wk.hyroxPlanNotes ?? []).find(n => /light strength block left out/.test(n));
          const circuit = ws.some(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
          if (!circuit) continue;
          if (!note) { wrong.push(`${label}: no light block and no note`); continue; }
          if (/48 h rule/.test(note)) continue;
          // Left out for the fraction: the fraction's spare, the finishers and
          // running above its floors hold less than the block (the week then
          // keeps its runs as they were).
          const d = generateHyroxPlanDetailed(s).detail[tw - 2];
          const exempt = ws.filter(w => (w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density') && (w.hyroxRounds ?? 0) <= 2
            && (w.hyroxComponents ?? []).filter(c => c.type !== 'run').length <= 2)
            .reduce<Workout | undefined>((m, w) => (!m || (w.estimatedDurationMin ?? 0) < (m.estimatedDurationMin ?? 0) ? w : m), undefined);
          const counted = ws.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0) - (exempt ? hyroxSessionWorkMin(exempt) : 0);
          const finishers = ws.reduce((a, w) => a + (w.hyroxSpec?.finisher?.min ?? 0), 0);
          const easyAbove = ws.filter(w => w.t === 'hyrox_run_easy' && !isHyroxLongRun(w)).reduce((a, w) => a + Math.max(0, (w.estimatedDurationMin ?? 0) - HYROX_RUN_FLOOR_MIN), 0);
          const long = ws.find(isHyroxLongRun);
          const otherKm = Math.max(0, ...ws.filter(w => w.discipline === 'run' && w !== long).map(hyroxRunLengthKm));
          const kmPerMin = long && (long.estimatedDurationMin ?? 0) > 0 ? hyroxRunLengthKm(long) / (long.estimatedDurationMin ?? 1) : 0;
          const longFloor = kmPerMin > 0 ? Math.max(HYROX_RUN_FLOOR_MIN, Math.ceil(otherKm / kmPerMin - 1e-9)) : 0;
          const longAbove = long ? Math.max(0, (long.estimatedDurationMin ?? 0) - longFloor) : 0;
          const room = Math.max(0, d.budgetMin - counted) + finishers + easyAbove + longAbove;
          if (room >= HYROX_STRENGTH_BLOCK_MIN + 1) wrong.push(`${label}: left out with ${room.toFixed(0)} min to give (${note})`);
        }
      }
    }
    expect(plans).toBe(96);
    expect(wrong.slice(0, 10)).toEqual([]);
    // Measured 2026-10-20 (review round 2): 73 of 96, 16 of 24 at the
    // default hours; the rest beginner-tier weeks at 3 h or more, whose
    // tempo (25 min, its shortest), circuit, mini brick and long run leave
    // no 20 min inside 0.55.
    expect(held).toBeGreaterThanOrEqual(70);
    expect(heldDefault).toBeGreaterThanOrEqual(16);
    expect(plansDefault).toBe(24);
  }, 120000);

  it('the standalone session takes its own day, never repeats its week\'s block, and a template session runs its 20 min (review: 66 base weeks repeated the block, booked at 45 min)', () => {
    let standalones = 0;
    for (const band of ['total_beginner', 'beginner', 'novice', 'intermediate'] as AbilityBand[]) {
      for (const h of [HYROX_HOURS_RANGE[band].default, 8].filter((x, i, a) => a.indexOf(x) === i)) {
        for (const len of [12, 16, 20]) {
          const s = build(band, h, len);
          for (const wk of s.wks) {
            const all = wk.triWorkouts ?? [];
            for (const st of standaloneOf(all)) {
              standalones++;
              const label = `${band} ${h}h ${len}w W${wk.w}`;
              // One session a day: no prescribed run on its day.
              expect(prescribed(wk).filter(w => w !== st && w.dayOfWeek === st.dayOfWeek), label).toEqual([]);
              const lines = (st.d ?? '').split('\n').filter(l => !/^stretch\b/i.test(l.trim()));
              for (const b of blocksOf(all)) expect(b.hyroxSpec!.strength!.lines, label).not.toEqual(lines);
              if (band !== 'intermediate') expect(st.estimatedDurationMin, label).toBe(HYROX_STRENGTH_BLOCK_MIN);
              else expect(st.estimatedDurationMin ?? 0, label).toBeGreaterThanOrEqual(HYROX_STRENGTH_BLOCK_MIN);
            }
          }
        }
      }
    }
    expect(standalones).toBeGreaterThan(20);
  }, 120000);
});

describe('a station session under a partial station capacity', () => {
  it('loses station work, keeps its warm-up and holds the station floor (review: 491 sessions under 15 min at a lower-body capacity of 50; review round 7: the floor counts the planned 10-min warm-up)', () => {
    let sessions = 0;
    const short: string[] = [];
    for (const band of BANDS) {
      for (const len of [12, 16]) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, len);
        for (const w0 of [1, 6]) {
          const inj = structuredClone(s);
          inj.w = w0;
          (inj as unknown as { injuryState: unknown }).injuryState = { active: true, runCapacity: 50, upperLoadCapacity: 100, lowerLoadCapacity: 50, location: 'knee' };
          const wks = regenerateHyroxWeeksFrom(inj, w0);
          wks.forEach((wk, k) => {
            for (const w of prescribed(wk ?? undefined)) {
              if (w.t !== 'hyrox_station_technique' && w.t !== 'hyrox_station_density') continue;
              sessions++;
              const label = `${band} ${len}w W${w0 + k} ${w.n}`;
              if (!floorHolds(w) || !holdsStationFloor(w)) short.push(`${label} ${hyroxSessionWorkMin(w).toFixed(1)} min of station work`);
              expect(w.hyroxSpec?.warmup, label).toBeDefined();
              expect(w.hyroxSpec?.finisher, label).toBeUndefined();
              // The gate cut it (the rebuilt week is not the ungated week: a
              // gated week's lower load moves the guard for later weeks, so
              // its sessions are compared with their own ungated shape in the
              // test below).
              expect(w.modReason ?? '', label).toMatch(/^Capacity 50%/);
              expect(w.d, label).toMatch(new RegExp(`^Warm-up`));
            }
          });
        }
      }
    }
    expect(sessions).toBeGreaterThan(50);
    expect(short).toEqual([]);
  }, 120000);

  it('keeps, within the capacity\'s share of its own and each restricted side\'s, the most work on the restricted side and then the most station work, cutting stations as well as rounds, the restricted side first, and every set of the restricted side at the capacity\'s share of it, singles and doubles, lower body at 10, 30, 50, 70 and 90 and upper body at 10, 30, 50 and 90; with no such shape that holds the floor it leaves (review round 3: whole rounds alone kept a median 43 to 45% at every capacity; round 4: a shoulder restriction cut the sled push and kept the SkiErg; round 5: the most station work first dropped the restricted side whole from about 60; round 6: a doubles session holding the restricted station as one set kept none of it from 50 to 90; round 7: with no fit the smallest shape stayed above the shares, open doubles mixed at upper body 10 kept 301 of 544 sessions, and a 2-set station went by whole rounds)', () => {
    // The rule is gateRule's (an independent copy). One-round sessions are
    // held to the same rule.
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['open singles', {}],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
      ['pro doubles men', { hyroxFormat: 'pro_doubles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>],
    ];
    const injuries: Array<['upper' | 'lower', number]> = [['lower', 10], ['lower', 30], ['lower', 50], ['lower', 70], ['lower', 90], ['upper', 10], ['upper', 30], ['upper', 50], ['upper', 90]];
    let checked = 0; let kept = 0; let oneRound = 0; let oneRoundCut = 0; let sideHeld = 0; let sidesDiffer = 0; let partialSets = 0; let multiSetPartial = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      const sessions: Array<[string, Workout]> = [];
      let access!: NonNullable<SimulatorState['hyroxConfig']>['stationAccess'];
      for (const band of BANDS) {
        for (const len of [12, 16]) {
          const s = build(band, HYROX_HOURS_RANGE[band].default, len, over);
          access = s.hyroxConfig!.stationAccess;
          for (const wk of s.wks) {
            for (const u of prescribed(wk)) {
              if (u.t === 'hyrox_station_technique' || u.t === 'hyrox_station_density') sessions.push([`${name} ${band} ${len}w W${wk.w} ${u.n}`, u]);
            }
          }
        }
      }
      for (const [side, cap] of injuries) {
        const upper = side === 'upper' ? cap : 100;
        const lower = side === 'lower' ? cap : 100;
        const inj = { active: true, runCapacity: 100, location: side === 'upper' ? 'shoulder' : 'knee', upperLoadCapacity: upper, lowerLoadCapacity: lower } as unknown as InjuryState;
        for (const [where, u] of sessions) {
          const label = `${side} ${cap} ${where}`;
          const own = hyroxSessionWorkMin(u);
          const want = gateRule(u, upper, lower, access);
          const [g] = applyHyroxInjuryGates([u], inj, 0, access);
          checked++;
          if ((u.hyroxRounds ?? 1) === 1) oneRound++;
          if (!g) {
            if (want) off.push(`${label}: left out, the rule keeps ${sigOf(want)} at ${want.estimatedDurationMin} min`);
            continue;
          }
          kept++;
          const work = hyroxSessionWorkMin(g);
          if ((u.hyroxRounds ?? 1) === 1 && work < own - 1e-6) oneRoundCut++;
          if ((g.hyroxComponents ?? []).some(c => c.raceFraction != null && c.raceFraction < 0.25 - 1e-9)) partialSets++;
          if ((g.hyroxComponents ?? []).some(c => c.type !== 'run' && hyroxComponentSets(c, g.hyroxRounds ?? 1) > 1
            && (u.hyroxComponents ?? []).some(x => x.type === c.type && ((x.reps ?? x.distanceM ?? 0) > (c.reps ?? c.distanceM ?? 0) + 1e-9)))) multiSetPartial++;
          if (!want || Math.abs(work - hyroxSessionWorkMin(want)) > 1e-6 || Math.abs(sideSecOf(g, side) - sideSecOf(want, side)) > 1e-6) off.push(`${label}: kept ${sigOf(g)} (${work.toFixed(1)} of ${own.toFixed(1)} min), the rule keeps ${sigOf(want)}`);
          // Always within the shares, and the floor holds.
          if (!withinShares(u, g, upper, lower)) off.push(`${label}: ${sigOf(u)} to ${sigOf(g)} above a share`);
          if (sideSecOf(u, side) > 0) sideHeld++;
          if (!floorHolds(g)) off.push(`${label}: under the station floor`);
          expect(g.hyroxSpec?.warmup, label).toBeDefined();
          expect(g.hyroxSpec?.finisher, label).toBeUndefined();
        }
      }
      // An upper and a lower restriction at the same capacity cut different
      // stations.
      for (const cap of [30, 50]) {
        const up = { active: true, runCapacity: 100, upperLoadCapacity: cap, lowerLoadCapacity: 100, location: 'shoulder' } as unknown as InjuryState;
        const lo = { active: true, runCapacity: 100, upperLoadCapacity: 100, lowerLoadCapacity: cap, location: 'knee' } as unknown as InjuryState;
        for (const [, u] of sessions) if (sigOf(applyHyroxInjuryGates([u], up, 0, access)[0]) !== sigOf(applyHyroxInjuryGates([u], lo, 0, access)[0])) sidesDiffer++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(kept).toBeGreaterThan(500);
    expect(sideHeld).toBeGreaterThan(300);
    expect(sidesDiffer).toBeGreaterThan(100);
    // One-round sessions (the doubles station floor's shape) lose station
    // work too, and partial sets reach kept sessions, multi-set stations
    // included.
    expect(oneRound).toBeGreaterThan(100);
    expect(oneRoundCut).toBeGreaterThan(0);
    expect(partialSets).toBeGreaterThan(100);
    expect(multiSetPartial).toBeGreaterThan(50);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);

  it('a shoulder restriction holds the SkiErg to its share and a knee restriction the sled push, and each keeps the restricted station at its share when the session stays (review round 4: total_beginner 12 w W2 went from row, farmers carry, SkiErg and sled push x4 to row and SkiErg x2 under upper body 50; round 8: the cut order no longer decides which station goes, the choice ranks the restricted side\'s work first)', () => {
    const s = build('total_beginner', HYROX_HOURS_RANGE.total_beginner.default, 12);
    const u = prescribed(s.wks[1]).find(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
    expect(u).toBeDefined();
    const types = (w: Workout | undefined) => (w?.hyroxComponents ?? []).map(c => c.type);
    expect(types(u)).toEqual(expect.arrayContaining(['ski_erg', 'sled_push']));
    for (const cap of [30, 50, 70]) {
      const [up] = applyHyroxInjuryGates([u!], { active: true, runCapacity: 100, upperLoadCapacity: cap, lowerLoadCapacity: 100 } as unknown as InjuryState);
      const [lo] = applyHyroxInjuryGates([u!], { active: true, runCapacity: 100, upperLoadCapacity: 100, lowerLoadCapacity: cap } as unknown as InjuryState);
      if (up) {
        expect(sideShareOf(u!, up, 'ski_erg'), `upper ${cap}`).toBeLessThanOrEqual(cap / 100 + 1e-6);
        expect(sideShareOf(u!, up, 'ski_erg'), `upper ${cap}`).toBeGreaterThan(0);
      }
      if (lo) {
        expect(sideShareOf(u!, lo, 'sled_push'), `lower ${cap}`).toBeLessThanOrEqual(cap / 100 + 1e-6);
        expect(sideShareOf(u!, lo, 'sled_push'), `lower ${cap}`).toBeGreaterThan(0);
      }
    }
  }, 60000);

  it('one side restricted, its capacity rising from 10 to 100 in steps of 5: every kept session within the shares, none leaves as the capacity rises, the restricted side\'s work never falls, and at clearance at most 1.6 times its work at 90 (the median under 1.2), singles, doubles, pro and one-erg singles and doubles (review round 5: 189 of 229 open singles sessions holding lower-body stations kept less of them at some higher capacity; round 6: doubles sessions kept none of the restricted side\'s work from 50 to 90; round 7: the smallest shape kept above the shares from 10 to 95, and singles kept a flat 50% from 50 to 95, then doubled; round 8: a session whose other stations were full-body went by whole rounds, so singles still stepped 2x at clearance, Row Erg only doubles 2.2x)', () => {
    const variants: Array<[string, Partial<OnboardingState>, boolean]> = [
      ['open singles', {}, false],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>, true],
      ['pro singles men', { hyroxFormat: 'pro_singles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>, false],
      ['pro doubles men', { hyroxFormat: 'pro_doubles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>, true],
      ['Row Erg only open singles', { hyroxHasSkiErg: false } as Partial<OnboardingState>, false],
      ['SkiErg only open doubles', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasRowErg: false } as Partial<OnboardingState>, true],
      ['Row Erg only open doubles', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasSkiErg: false } as Partial<OnboardingState>, true],
    ];
    const caps = Array.from({ length: 19 }, (_, i) => 10 + 5 * i);
    let checked = 0; let keptAt90 = 0;
    const steps: number[] = [];
    const falls: string[] = [];
    for (const [name, over, doubles] of variants) {
      for (const band of BANDS) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, 12, over);
        const access = s.hyroxConfig!.stationAccess;
        for (const wk of s.wks) {
          for (const u of prescribed(wk)) {
            if (u.t !== 'hyrox_station_technique' && u.t !== 'hyrox_station_density') continue;
            for (const side of ['upper', 'lower'] as const) {
              const all = sideSecOf(u, side);
              if (all <= 0) continue;
              checked++;
              const label = `${name} ${band} W${wk.w} ${u.n} ${side}`;
              const gs = caps.map(cap => applyHyroxInjuryGates([u], {
                active: true, runCapacity: 100,
                upperLoadCapacity: side === 'upper' ? cap : 100, lowerLoadCapacity: side === 'lower' ? cap : 100,
              } as unknown as InjuryState, 0, access)[0]);
              gs.push(u);
              const capsAll = [...caps, 100];
              for (let k = 0; k < capsAll.length; k++) {
                const g = gs[k];
                if (!g) continue;
                if (capsAll[k] < 100 && !withinShares(u, g, side === 'upper' ? capsAll[k] : 100, side === 'lower' ? capsAll[k] : 100)) falls.push(`${label}: above a share at ${capsAll[k]}`);
                const next = gs[k + 1];
                if (k + 1 < gs.length && !next) falls.push(`${label}: kept at ${capsAll[k]}, left out at ${capsAll[k + 1]}`);
                if (next && sideSecOf(next, side) < sideSecOf(g, side) - 1e-6) falls.push(`${label}: ${sideSecOf(g, side)} s at ${capsAll[k]}, ${sideSecOf(next, side)} s at ${capsAll[k + 1]}`);
              }
              // At clearance the restricted side's work steps at most 1.6
              // times from 90; a singles session kept at 90 always holds
              // some of it.
              const at90 = sideSecOf(gs[caps.indexOf(90)], side);
              if (at90 > 0) {
                keptAt90++;
                steps.push(all / at90);
                if (all > 1.6 * at90 + 1e-6) falls.push(`${label}: ${at90} s at 90, ${all} s at 100`);
              } else if (gs[caps.indexOf(90)] && !doubles) falls.push(`${label}: kept at 90 with none of its ${side}-body work`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
    expect(keptAt90).toBeGreaterThan(checked * 0.7);
    // Measured 2026-10-22 (review round 8): the median step 1.12 to 1.15,
    // the largest 1.54 (Row Erg only singles, lower body).
    steps.sort((a, b) => a - b);
    expect(steps[Math.floor(steps.length / 2)]).toBeLessThan(1.2);
    expect(falls.slice(0, 10)).toEqual([]);
  }, 300000);

  it('holds each restricted side to the share at its own capacity, both sides restricted unequally or equally (review round 5: round 4 held the lower-capacity side only; review round 6: equal capacities held the session share only, open singles at 70/70 kept upper-body stations above 70% in 91 of 123 kept sessions)', () => {
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['open singles', {}],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
    ];
    const pairs: Array<[number, number]> = [[30, 50], [50, 70], [70, 30], [90, 50], [30, 30], [50, 50], [70, 70], [90, 90]];
    const types = (w: Workout | undefined) => (w?.hyroxComponents ?? []).map(c => c.type);
    let held = 0; let sledShape = 0; let equalHeld = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      for (const band of BANDS) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, 12, over);
        const access = s.hyroxConfig!.stationAccess;
        for (const wk of s.wks) {
          for (const u of prescribed(wk)) {
            if (u.t !== 'hyrox_station_technique' && u.t !== 'hyrox_station_density') continue;
            for (const [up, lo] of pairs) {
              const label = `${name} ${band} W${wk.w} ${u.n} upper ${up} lower ${lo}`;
              const want = gateRule(u, up, lo, access);
              const [g] = applyHyroxInjuryGates([u], { active: true, runCapacity: 100, upperLoadCapacity: up, lowerLoadCapacity: lo } as unknown as InjuryState, 0, access);
              if (!!g !== !!want || (g && want && (Math.abs(hyroxSessionWorkMin(g) - hyroxSessionWorkMin(want)) > 1e-6
                || Math.abs(sideSecOf(g, 'upper') - sideSecOf(want, 'upper')) > 1e-6 || Math.abs(sideSecOf(g, 'lower') - sideSecOf(want, 'lower')) > 1e-6))) {
                off.push(`${label}: kept ${sigOf(g)}, the rule keeps ${sigOf(want)}`);
              }
              if (!g) continue;
              held++;
              if (up === lo) equalHeld++;
              if (!withinShares(u, g, up, lo)) off.push(`${label}: ${sigOf(u)} to ${sigOf(g)} above a share`);
              // A one-round [sled push, sled pull, row, farmers carry] session
              // under upper body 30 and lower body 50 keeps no whole sled push
              // set: the review's open doubles example kept the sled push and
              // the row whole.
              if (up === 30 && lo === 50 && u.hyroxRounds === 1 && [...types(u)].sort().join() === ['farmer_carry', 'row_erg', 'sled_pull', 'sled_push'].join()) {
                sledShape++;
                expect(sideSecOf(g, 'lower'), label).toBeLessThanOrEqual(0.5 * sideSecOf(u, 'lower') + 1e-6);
              }
            }
          }
        }
      }
    }
    expect(held).toBeGreaterThan(300);
    expect(equalHeld).toBeGreaterThan(100);
    expect(sledShape).toBeGreaterThanOrEqual(0);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);

  it('no kept session leaves, and the lower-capacity side\'s work never falls while it stays the lower, as any single capacity (run, upper body, lower body) rises by 5, a side clearing to 100 under a two-sided restriction and a side stepping onto or off a tie included: one-sided sweeps at run 100, 50 and 0, equal restrictions with run capacity swept, and one side swept with the other at 25, 40, 45, 50, 85 and 95 (review round 7: equal restrictions kept a whole erg warm-up, so 264 open singles men sessions kept at run 50 left at run 60 under 50/50, and a session kept at 30/30 left at 30/35; round 8: a side clearing from 95 to 100 took sessions out, open doubles mixed sessions kept at upper body 40 fell from 174 to 86, and sessions left as the higher side rose below clearance, open singles men at lower body 40 from upper body 80 to 85)', () => {
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['open singles', {}],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
      ['Row Erg only open doubles', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasSkiErg: false } as Partial<OnboardingState>],
      ['SkiErg only open doubles', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasRowErg: false } as Partial<OnboardingState>],
    ];
    // [run, upper, lower] states, each stepped by 5 in each capacity below 100.
    const states: Array<[number, number, number]> = [];
    const steps = Array.from({ length: 18 }, (_, i) => 10 + 5 * i); // 10 to 95
    for (const run of [100, 50, 0]) for (const c of steps) states.push([run, c, 100], [run, 100, c]);
    for (const e of [30, 50, 70, 90]) for (let run = 0; run <= 95; run += 5) states.push([run, e, e]);
    for (const o of [25, 40, 45, 50, 85, 95]) for (const c of steps) states.push([100, c, o], [100, o, c]);
    for (const c of steps) states.push([50, c, 50], [50, 50, c]);
    let kept = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      for (const band of BANDS) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, 12, over);
        const access = s.hyroxConfig!.stationAccess;
        const sessions = s.wks.flatMap(wk => prescribed(wk)).filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
        const gate = (u: Workout, [run, up, lo]: [number, number, number]) => applyHyroxInjuryGates([u], { active: true, runCapacity: run, upperLoadCapacity: up, lowerLoadCapacity: lo } as unknown as InjuryState, 0, access)[0];
        for (const u of sessions) {
          for (const st of states) {
            if (!gate(u, st)) continue;
            kept++;
            for (let d = 0; d < 3; d++) {
              if (st[d] >= 100) continue;
              const nx = [...st] as [number, number, number];
              nx[d] = Math.min(100, nx[d] + 5);
              const g = gate(u, st) as Workout;
              const h = gate(u, nx);
              if (!h) { off.push(`${name} ${band} ${u.n}: kept at ${st.join('/')}, left out at ${nx.join('/')}`); continue; }
              // The lower-capacity side, before and after the step.
              const lowB = st[1] < st[2] ? 'upper' : st[2] < st[1] ? 'lower' : null;
              const lowA = nx[1] < nx[2] ? 'upper' : nx[2] < nx[1] ? 'lower' : null;
              if (lowB && lowB === lowA && sideSecOf(h, lowB) < sideSecOf(g, lowB) - 1e-6) off.push(`${name} ${band} ${u.n}: ${lowB} body ${sideSecOf(g, lowB)} s at ${st.join('/')}, ${sideSecOf(h, lowB)} s at ${nx.join('/')}`);
            }
          }
        }
      }
    }
    expect(kept).toBeGreaterThan(10000);
    expect(off.slice(0, 10)).toEqual([]);
  }, 900000);

  it('one side swept from 10 to 100 in steps of 5 with the other at 50: each side within its own share, and the swept side\'s work never falls while it is the lower capacity (review round 6: through equality the swept side\'s work fell at a higher capacity in 38 of 134 open singles and 22 of 134 open doubles sessions under upper body, 56 of 229 and 16 of 234 under lower body)', () => {
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['open singles', {}],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
    ];
    const sweep = Array.from({ length: 19 }, (_, i) => 10 + 5 * i);
    let series = 0; let held = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      for (const band of BANDS) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, 12, over);
        const access = s.hyroxConfig!.stationAccess;
        for (const wk of s.wks) {
          for (const u of prescribed(wk)) {
            if (u.t !== 'hyrox_station_technique' && u.t !== 'hyrox_station_density') continue;
            for (const moving of ['upper', 'lower'] as const) {
              if (sideSecOf(u, moving) <= 0) continue;
              series++;
              let last = -1;
              let lastWork = 0;
              for (const cap of sweep) {
                const up = moving === 'upper' ? cap : 50;
                const lo = moving === 'lower' ? cap : 50;
                const label = `${name} ${band} W${wk.w} ${u.n} upper ${up} lower ${lo}`;
                const [g] = applyHyroxInjuryGates([u], { active: true, runCapacity: 100, upperLoadCapacity: up, lowerLoadCapacity: lo } as unknown as InjuryState, 0, access);
                if (g) {
                  held++;
                  if (!withinShares(u, g, up, lo)) off.push(`${label}: ${sigOf(u)} to ${sigOf(g)} above a share`);
                }
                if (cap >= 50) continue;
                const work = sideSecOf(g, moving);
                if (last >= 0 && work < lastWork - 1e-6) off.push(`${label}: ${moving} body ${lastWork} s at ${last}, ${work} s at ${cap}`);
                last = cap;
                lastWork = work;
              }
            }
          }
        }
      }
    }
    expect(series).toBeGreaterThan(150);
    expect(held).toBeGreaterThan(2000);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);
});

describe('a station session\'s warm-up under an injury', () => {
  type Mode = NonNullable<NonNullable<Workout['hyroxSpec']>['warmup']>['mode'];
  /** The warm-up rule, an independent copy (review rounds 4 to 7): each way
   *  the athlete can warm up has a capacity of its own (a jog the run
   *  capacity, the SkiErg the upper body's, the Row Erg the lower of the two
   *  sides', HYROX_STATION_REGION's full-body row); the warm-up takes the
   *  highest, ties in the decision's order (an upper-body restriction: Row
   *  Erg, jog, SkiErg; a lower-body one: SkiErg, jog, Row Erg; equal: the
   *  planned way first), and below 100 keeps that capacity's share of 10 min
   *  (at least 1, at 0 none), equal restrictions too. */
  const warmRule = (planned: Mode, run: number, upper: number, lower: number, access: NonNullable<SimulatorState['hyroxConfig']>['stationAccess']): { mode: Mode; min: number } => {
    const capOf = (m: Mode) => (m === 'run' ? run : m === 'ski_erg' ? upper : m === 'row_erg' ? Math.min(upper, lower) : 100);
    const restricted = upper < lower ? 'upper' : lower < upper ? 'lower' : null;
    const order: Mode[] = restricted === 'upper' ? ['row_erg', 'run', 'ski_erg'] : restricted === 'lower' ? ['ski_erg', 'run', 'row_erg'] : [planned, 'run', 'row_erg', 'ski_erg'];
    const has = (m: Mode) => m === planned || m === 'run' || (m === 'ski_erg' && access.skiErg) || (m === 'row_erg' && access.rowErg);
    const ways = [...order, planned].filter(has);
    const top = Math.max(...ways.map(capOf));
    const mode = ways.find(m => capOf(m) === top) as Mode;
    const c = capOf(mode);
    return { mode, min: c >= 100 ? 10 : c <= 0 ? 0 : Math.min(10, Math.max(1, Math.round(c / 10))) };
  };

  it('takes the way with the highest capacity of its own (a jog the run capacity, the SkiErg the upper body\'s, the Row Erg the lower of the two sides\'), ties in the decision\'s order, and keeps that capacity\'s share, equal restrictions too; never opens a kept session with a whole SkiErg or Row Erg warm-up under an upper-body restriction; the station floor counts the planned warm-up (review round 5: open singles men under upper body 30, 157 kept sessions opened with 10 min on the SkiErg; review round 6: under the neck default every kept session opened with a whole Row Erg warm-up; review round 7: equal restrictions kept an erg whole, so a jog cut to the run share replaced it as run capacity rose and the session then left)', () => {
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['both ergs', {}],
      ['SkiErg only', { hyroxHasRowErg: false } as Partial<OnboardingState>],
      ['Row Erg only', { hyroxHasSkiErg: false } as Partial<OnboardingState>],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
    ];
    // [run, upper body, lower body]: one-sided at 30 to 90 with run 100 and
    // 50; the neck and chest_ribs defaults (run 50, upper 50 / upper 30 and
    // lower 50); the elbow default (run 100, lower 50) with upper body
    // through equality; equal sides with run 50, 60, 70, 90 and 100.
    const states: Array<[number, number, number]> = [];
    for (const cap of [30, 50, 70, 90]) for (const run of [100, 50]) states.push([run, cap, 100], [run, 100, cap]);
    states.push([50, 50, 100], [50, 30, 50], [100, 45, 50], [100, 50, 50], [100, 55, 50], [50, 50, 50], [60, 50, 50], [70, 50, 50], [90, 50, 50], [50, 30, 30]);
    let kept = 0; let moved = 0; let shared = 0; let equalShared = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      for (const band of BANDS) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, 12, over);
        const access = s.hyroxConfig!.stationAccess;
        const sessions = s.wks.flatMap(wk => prescribed(wk)).filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
        for (const [run, upper, lower] of states) {
          const inj = { active: true, runCapacity: run, upperLoadCapacity: upper, lowerLoadCapacity: lower } as unknown as InjuryState;
          for (const u of sessions) {
            const [g] = applyHyroxInjuryGates([u], inj, 0, access);
            if (!g) continue;
            kept++;
            const wu = g.hyroxSpec?.warmup;
            const planned = u.hyroxSpec!.warmup!.mode;
            const want = warmRule(planned, run, upper, lower, access);
            const label = `${name} ${band} ${u.n} run ${run} upper ${upper} lower ${lower}: ${wu ? `${wu.min} min ${wu.mode}` : 'none'}, the rule ${want.min} min ${want.mode}`;
            if (!wu || wu.mode !== want.mode || wu.min !== want.min) off.push(label);
            if (want.mode !== planned) {
              moved++;
              if (!(g.modReason ?? '').includes('in place of the')) off.push(`${label}: no note`);
            }
            if (want.min < 10) {
              shared++;
              if (upper === lower && want.mode !== 'run') equalShared++;
              if (!(g.modReason ?? '').includes(` cut to ${want.min} min.`)) off.push(`${label}: no cut note`);
            }
            if (upper < 100 && upper < lower && wu && wu.mode !== 'run' && wu.min >= 10) off.push(`${label}: a whole erg warm-up under an upper-body restriction`);
            if (!floorHolds(g) || !holdsStationFloor(g)) off.push(`${label}: under the station floor`);
          }
        }
      }
    }
    expect(kept).toBeGreaterThan(3000);
    expect(moved).toBeGreaterThan(1000);
    expect(shared).toBeGreaterThan(300);
    expect(equalShared).toBeGreaterThan(50);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);

  it('under equal restrictions no session kept at a lower run capacity leaves at a higher one, and the warm-up never shortens as run capacity rises (review round 7: at upper and lower body 50/50, 264 open singles men sessions kept at run 50 left at run 60, and came back at 100)', () => {
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['both ergs', {}],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
      ['SkiErg only open doubles', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasRowErg: false } as Partial<OnboardingState>],
    ];
    let series = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      for (const band of BANDS) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, 12, over);
        const access = s.hyroxConfig!.stationAccess;
        const sessions = s.wks.flatMap(wk => prescribed(wk)).filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
        for (const e of [30, 50, 70]) {
          for (const u of sessions) {
            series++;
            let prev: Workout | undefined;
            for (let run = 0; run <= 100; run += 5) {
              const [g] = applyHyroxInjuryGates([u], { active: true, runCapacity: run, upperLoadCapacity: e, lowerLoadCapacity: e } as unknown as InjuryState, 0, access);
              const label = `${name} ${band} ${u.n} ${e}/${e} run ${run}`;
              if (prev && !g) off.push(`${label}: left out, kept at run ${run - 5}`);
              if (prev && g && (g.hyroxSpec?.warmup?.min ?? 0) < (prev.hyroxSpec?.warmup?.min ?? 0)) off.push(`${label}: warm-up ${prev.hyroxSpec?.warmup?.min} to ${g.hyroxSpec?.warmup?.min} min`);
              prev = g;
            }
          }
        }
      }
    }
    expect(series).toBeGreaterThan(300);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);

  it('reaches the rebuilt plan: under a shoulder restriction no current or future station session opens with a SkiErg warm-up, a whole jog at run capacity 100, a Row Erg warm-up at the shared capacity\'s 5 min at run 50 (the plan passes the athlete\'s ergs to the gates)', () => {
    let sessions = 0;
    for (const band of BANDS) {
      const s = build(band, HYROX_HOURS_RANGE[band].default, 12);
      for (const run of [100, 50]) {
        const st = structuredClone(s);
        st.w = 1;
        (st as unknown as { injuryState: unknown }).injuryState = { active: true, runCapacity: run, upperLoadCapacity: 50, lowerLoadCapacity: 100, location: 'shoulder' };
        for (const wk of regenerateHyroxWeeksFrom(st, 1)) {
          for (const w of prescribed(wk ?? undefined)) {
            if (w.t !== 'hyrox_station_technique' && w.t !== 'hyrox_station_density') continue;
            sessions++;
            const label = `${band} W${wk?.w} ${w.n} run ${run}`;
            expect(w.hyroxSpec?.warmup?.mode, label).toBe(run >= 100 ? 'run' : 'row_erg');
            expect(w.hyroxSpec?.warmup?.min, label).toBe(run >= 100 ? 10 : 5);
          }
        }
      }
    }
    expect(sessions).toBeGreaterThan(50);
  }, 120000);
});

describe('a station session\'s jog warm-up under a run restriction', () => {
  it('follows the run capacity: with neither erg, no jog under run capacity 0 (the first round at easy effort serves as the warm-up, and the card says so; a one-round session leaves), a 5-min jog under 50, every station session at the station floor, singles and doubles (review round 4: under run capacity 0, 175 of 175 station sessions opened with a 10-min jog; review round 5: no warm-up at all, and no doubles case; review round 7: a one-round session became all warm-up, and its planned TSS priced round 1 at the session\'s RPE)', () => {
    const NO_ERGS = { hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>;
    const cases: Array<[number, number]> = [[0, 100], [0, 50], [50, 100], [50, 50]];
    let ungatedJogs = 0; let sessions = 0; let stationOnly = 0; let oneRoundLeft = 0; let round1Priced = 0;
    const off: string[] = [];
    const DOUBLES = { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>;
    const roundOneMin = (w: Workout) => hyroxSessionWalk(w).filter(x => x.round === 1).reduce((a, x) => a + (x.component.durationSec ?? 0) + x.restSec + x.transitionSec, 0) / 60;
    for (const [fmt, over] of [['singles', {}], ['doubles', DOUBLES]] as Array<[string, Partial<OnboardingState>]>) for (const band of BANDS) {
      for (const len of fmt === 'singles' ? [12, 16] : [12]) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, len, { ...NO_ERGS, ...over });
        const ungated = s.wks.flatMap(wk => prescribed(wk)).filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
        ungatedJogs += ungated.filter(w => w.hyroxSpec?.warmup?.mode === 'run' && w.hyroxSpec.warmup.min === 10).length;
        for (const [runCap, lower] of cases) {
          const inj = { active: true, runCapacity: runCap, upperLoadCapacity: 100, lowerLoadCapacity: lower, location: 'knee' } as unknown as InjuryState;
          // The gate alone, on the ungated sessions (station capacity 100:
          // only the warm-up changes).
          if (lower === 100) {
            for (const u of ungated) {
              const [g] = applyHyroxInjuryGates([u], inj);
              stationOnly++;
              // The floor: the planned 10-min warm-up with the station work,
              // after round 1 when round 1 is the warm-up (run capacity 0).
              const after = hyroxSessionWorkMin(u) - (runCap === 0 ? roundOneMin(u) : 0);
              if (!g) {
                if (Math.round(after + 10) >= 15) off.push(`${band} ${len}w ${u.n} run ${runCap}: left out with ${after.toFixed(1)} min of station work after the warm-up`);
                if (runCap === 0 && (u.hyroxRounds ?? 1) === 1) oneRoundLeft++;
                continue;
              }
              if (Math.round(after + 10) < 15) off.push(`${band} ${len}w ${u.n} run ${runCap}: kept with ${after.toFixed(1)} min of station work after the warm-up`);
              if (hyroxSessionWorkMin(g) !== hyroxSessionWorkMin(u)) off.push(`${band} ${len}w ${u.n} run ${runCap}: station work changed`);
              expect(g.modReason ?? '').toMatch(/^Run capacity /);
              if (runCap === 0) {
                expect(g.hyroxRounds ?? 1).toBeGreaterThan(1);
                expect(g.modReason ?? '').toContain('Take the first round at easy effort as the warm-up.');
                // Written into the session: round 1's sets at the easy RPE,
                // in its spec, its text, its MTL (linear in the RPE) and its
                // planned TSS.
                expect(g.hyroxSpec?.warmupRound).toBe(true);
                expect(g.d ?? '').toMatch(new RegExp(`^Warm-up: round 1 at easy effort \\(RPE ${HYROX_EASY_RPE}\\)\\.`));
                const rounds = g.hyroxRounds ?? 1;
                const rpe = g.rpe ?? 5;
                const want = (g.hyroxComponents ?? []).reduce((a, c) => {
                  const sets = hyroxComponentSets(c, rounds);
                  const inFirst = !c.inRounds || c.inRounds.includes(1);
                  return a + c.mtl - (inFirst && sets > 0 ? (c.mtl / sets) * (1 - HYROX_EASY_RPE / rpe) : 0);
                }, 0);
                expect(g.musculoTendonLoad ?? 0).toBeCloseTo(want, 6);
                expect(g.musculoTendonLoad ?? 0).toBeLessThan((u.musculoTendonLoad ?? 0) - (u.hyroxSpec?.warmup?.mtl ?? 0) - 1e-6);
                const dur = g.estimatedDurationMin ?? 0;
                const easy = Math.min(dur, roundOneMin(g));
                const tssWant = (dur - easy) * plannedTssPerMin(g.t ?? '', rpe) + easy * plannedTssPerMin('', HYROX_EASY_RPE);
                expect(hyroxSessionPlannedTss(g)).toBeCloseTo(tssWant, 6);
                expect(hyroxSessionPlannedTss(g)).toBeLessThan(dur * plannedTssPerMin(g.t ?? '', rpe) - 1e-6);
                round1Priced++;
              }
            }
          }
          // The rebuilt plan.
          const st = structuredClone(s);
          st.w = 1;
          (st as unknown as { injuryState: unknown }).injuryState = inj;
          for (const wk of regenerateHyroxWeeksFrom(st, 1)) {
            for (const w of prescribed(wk ?? undefined)) {
              if (w.t !== 'hyrox_station_technique' && w.t !== 'hyrox_station_density') continue;
              sessions++;
              const label = `${fmt} ${band} ${len}w W${wk?.w} ${w.n} run ${runCap} lower ${lower}`;
              const wu = w.hyroxSpec?.warmup;
              if (runCap === 0 && wu) off.push(`${label}: ${wu.min}-min ${wu.mode} warm-up`);
              if (runCap === 0 && !(w.modReason ?? '').includes('Take the first round at easy effort as the warm-up.')) off.push(`${label}: no warm-up note`);
              if (runCap === 0 && (!w.hyroxSpec?.warmupRound || !(w.d ?? '').startsWith('Warm-up: round 1 at easy effort'))) off.push(`${label}: round 1 not written as the warm-up`);
              if (runCap === 0 && (w.hyroxRounds ?? 1) <= 1) off.push(`${label}: one round, all of it the warm-up`);
              if (runCap === 50 && !(wu?.mode === 'run' && wu.min === 5)) off.push(`${label}: warm-up ${wu ? `${wu.min} min ${wu.mode}` : 'none'}`);
              if (!floorHolds(w) || !holdsStationFloor(w)) off.push(`${label}: ${hyroxSessionWorkMin(w).toFixed(1)} min of station work under the floor`);
            }
          }
        }
      }
    }
    expect(ungatedJogs).toBeGreaterThan(150);
    expect(stationOnly).toBeGreaterThan(300);
    expect(sessions).toBeGreaterThan(300);
    expect(oneRoundLeft).toBeGreaterThan(0);
    expect(round1Priced).toBeGreaterThan(50);
    expect(off.slice(0, 10)).toEqual([]);
  }, 120000);

  it('the 15-min station floor counts the planned 10-min warm-up whatever the gates left of it, and with round 1 as the warm-up the station work after round 1 (review round 7: a shortened warm-up decided whether a session stayed, and round 6 counted no warm-up with round 1 as it)', () => {
    let checked = 0; let shortened = 0;
    for (const band of BANDS) {
      const s = build(band, HYROX_HOURS_RANGE[band].default, 12, { hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>);
      const roundOneMin = (w: Workout) => hyroxSessionWalk(w).filter(x => x.round === 1).reduce((a, x) => a + (x.component.durationSec ?? 0) + x.restSec + x.transitionSec, 0) / 60;
      for (const run of [0, 30]) {
        const inj = { active: true, runCapacity: run, upperLoadCapacity: 100, lowerLoadCapacity: 100 } as unknown as InjuryState;
        for (const u of s.wks.flatMap(wk => prescribed(wk)).filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density')) {
          const [g] = applyHyroxInjuryGates([u], inj);
          if (!g) continue;
          if (run === 0) expect(g.hyroxSpec?.warmupRound).toBe(true);
          else { expect(g.hyroxSpec?.warmup?.min).toBe(3); shortened++; }
          // Every cut of rounds and stations.
          for (let st = g; ;) {
            for (let r = st.hyroxRounds ?? 1; r >= 1; r--) {
              const x = withHyroxRounds(st, r);
              checked++;
              const after = hyroxSessionWorkMin(x) - (run === 0 ? roundOneMin(x) : 0);
              expect(holdsStationFloor(x), `${band} ${u.n} run ${run} ${hyroxSessionWorkMin(x).toFixed(1)} min`).toBe(Math.round(after + 10) >= 15);
              if (run === 0 && r === 1) expect(holdsStationFloor(x)).toBe(false);
            }
            const cut = hyroxStationToCut(st);
            const next = cut ? withoutHyroxStation(st, cut) : st;
            if (next === st) break;
            st = next;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(shortened).toBeGreaterThan(20);
  }, 120000);

  it('a race-week circuit planned under the floor (a short primer the floor exempts) stays through a run restriction alone whatever its warm-up becomes, unless round 1 as its warm-up leaves one round, and a session that held the floor never stays under it (review round 8: one-erg doubles race-week circuits left whenever their warm-up changed way and stayed when it did not)', () => {
    let exempt = 0; let kept = 0; let held = 0;
    const variants: Array<Partial<OnboardingState>> = [
      { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasRowErg: false } as Partial<OnboardingState>,
      { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasSkiErg: false } as Partial<OnboardingState>,
    ];
    for (const over of variants) {
      for (const band of BANDS) {
        for (const len of [8, 12]) {
          const s = build(band, HYROX_HOURS_RANGE[band].min, len, over);
          const access = s.hyroxConfig!.stationAccess;
          const tw = planTrainingWeeks(s);
          for (const [k, wk] of s.wks.slice(0, tw).entries()) {
            // Each circuit as planned and with a planned jog warm-up (at run
            // capacity 0 or 30 the jog moves to the erg or shortens).
            const circuits = prescribed(wk).filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
            for (const u of circuits.flatMap(w => [w, withHyroxSessionParts(w, { warmup: hyroxWarmupOn('run', 10) })])) {
              for (const run of [0, 30, 50]) {
                const [g] = applyHyroxInjuryGates([u], { active: true, runCapacity: run, upperLoadCapacity: 100, lowerLoadCapacity: 100 } as unknown as InjuryState, 0, access);
                const label = `${band} ${len} w W${k + 1} ${u.n} ${u.hyroxSpec?.warmup?.mode} warm-up, run ${run}`;
                if (holdsStationFloor(u)) {
                  held++;
                  if (g) expect(holdsStationFloor(g), label).toBe(true);
                  continue;
                }
                expect(k + 1, `${label}: only race week's circuit is planned under the floor`).toBe(tw);
                exempt++;
                const oneRound = !!g?.hyroxSpec?.warmupRound && (g.hyroxRounds ?? 1) <= 1;
                expect(!!g || (u.hyroxRounds ?? 1) <= 1, label).toBe(true);
                if (g) { kept++; expect(oneRound, label).toBe(false); }
              }
            }
          }
        }
      }
    }
    expect(exempt).toBeGreaterThan(20);
    expect(kept).toBe(exempt);
    expect(held).toBeGreaterThan(500);
  }, 120000);
});
