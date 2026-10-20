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
 *     the restricted capacity's share (review round 5).
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
import { hyroxSessionWorkMin, withHyroxRounds, hyroxRunLengthKm, withoutHyroxStation, hyroxStationToCut, withHyroxFinisher, withHyroxSessionParts, withHyroxPartialSet } from './hyrox-generators';
import { hyroxSessionWalk, hyroxComponentSets } from './hyrox-session-shape';
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

/**
 * The injury gate's station-session choice, an independent copy of the rule
 * (review rounds 3 to 6), for a session whose warm-up keeps its 10 min (run
 * capacity 100 with both ergs: the warm-up moves to a jog or the free erg
 * whole). Candidates: every shape of the cut walk (the lowest-capacity side's
 * stations first, then the full-body ones, then the other side's; both sides
 * first at a tie; down to MIN_CIRCUIT_STATIONS stations and one round), and
 * every shape of the partial walk (the full-body stations, then an
 * unrestricted side's; a restricted side's stay) with each single set of a
 * restricted side's station at its side's capacity share (and, under two
 * unequal restrictions, at the station capacity's too). A candidate fits when
 * its station work is at or under the station capacity's share and each
 * restricted side's at or under its own. The session keeps, of the fits that
 * run 15 min or more, the most work on each restricted side (lowest capacity
 * first, the lower body first at a tie), then the most station work; with no
 * such fit it leaves when a whole shape fits, else keeps the smallest whole
 * shape (under two unequal restrictions, the alternative order's smallest when
 * it holds less restricted work and runs 15 min).
 */
function gateRule(u: Workout, upper: number, lower: number, access: NonNullable<SimulatorState['hyroxConfig']>['stationAccess']): { kept: Workout | undefined; fallback: boolean; fitsAny15: boolean } {
  const capOf = { upper, lower } as const;
  const stationCap = Math.min(upper, lower);
  const low: 'upper' | 'lower' | null = upper < lower ? 'upper' : lower < upper ? 'lower' : null;
  const sides = (['lower', 'upper'] as const).filter(r => capOf[r] < 100).sort((a, b) => capOf[a] - capOf[b]);
  const restrictedSt = (st: HyroxStation) => { const r = HYROX_STATION_REGION[st]; return r !== 'full' && capOf[r] < 100; };
  const rank = (st: HyroxStation) => { const r = HYROX_STATION_REGION[st]; return r === 'full' ? 1 : low == null || r === low ? 0 : 2; };
  const s0 = withHyroxSessionParts(withHyroxFinisher(u, 0, access, 0), { strength: null });
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
  const whole = walk(rank);
  const partial: Workout[] = [];
  for (const c of walk(st => (restrictedSt(st) ? 3 : rank(st)), restrictedSt)) {
    for (const own of sides.length === 2 && low != null ? [true, false] : [true]) {
      let p: Workout | null = null;
      for (const comp of c.hyroxComponents ?? []) {
        const st = comp.type as HyroxStation;
        if (comp.type === 'run' || !restrictedSt(st) || hyroxComponentSets(comp, c.hyroxRounds ?? 1) !== 1) continue;
        const r = HYROX_STATION_REGION[st] as 'upper' | 'lower';
        p = withHyroxPartialSet(p ?? c, st, (own ? capOf[r] : stationCap) / 100) ?? p;
      }
      if (p) partial.push(p);
    }
  }
  const fits = (c: Workout) => hyroxSessionWorkMin(c) <= (stationCap / 100) * hyroxSessionWorkMin(u) + 1e-6
    && sides.every(r => sideSecOf(c, r) <= (capOf[r] / 100) * sideSecOf(u, r) + 1e-6);
  const holds15 = (c: Workout) => (c.estimatedDurationMin ?? 0) >= 15;
  const key = (c: Workout) => [...sides.map(r => sideSecOf(c, r)), hyroxSessionWorkMin(c) * 60];
  const above = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) { if (a[i] > b[i] + 1e-6) return true; if (a[i] < b[i] - 1e-6) return false; } return false; };
  const keep = [...whole, ...partial].filter(c => fits(c) && holds15(c));
  if (keep.length > 0) return { kept: keep.reduce((a, c) => (above(key(c), key(a)) ? c : a)), fallback: false, fitsAny15: true };
  if (whole.some(fits)) return { kept: undefined, fallback: false, fitsAny15: false };
  let kept = whole.reduce((a, c) => (hyroxSessionWorkMin(c) < hyroxSessionWorkMin(a) - 1e-9 ? c : a));
  if (!holds15(kept)) return { kept: undefined, fallback: true, fitsAny15: false };
  if (low != null && sides.length === 2) {
    const other = low === 'upper' ? 'lower' : 'upper';
    const alt = walk(st => { const r = HYROX_STATION_REGION[st]; return r === low ? 0 : r === other ? 1 : 2; })
      .reduce((a, c) => (hyroxSessionWorkMin(c) < hyroxSessionWorkMin(a) - 1e-9 ? c : a));
    if (holds15(alt) && above(key(kept), key(alt))) kept = alt;
  }
  return { kept, fallback: true, fitsAny15: false };
}

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
  it('loses station work, keeps its warm-up and runs 15 min or more (review: 491 sessions under 15 min at a lower-body capacity of 50)', () => {
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
              if ((w.estimatedDurationMin ?? 0) < 15) short.push(`${label} ${w.estimatedDurationMin}`);
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

  it('keeps, within the capacity\'s share of its own and each restricted side\'s, the most work on the restricted side and then the most station work, cutting stations as well as rounds, the restricted side first, and a single set of the restricted side at the capacity\'s share of it, singles and doubles, lower body at 30, 50, 70 and 90 and upper body at 30, 50 and 90 (review round 3: whole rounds alone kept a median 43 to 45% at every capacity, and a one-round doubles session all of it; review round 4: a shoulder restriction cut the sled push and kept the SkiErg; review round 5: the most station work first dropped the restricted side whole from about 60; review round 6: a doubles session holding the restricted station as one set kept none of it from 50 to 90)', () => {
    // The rule is gateRule's (an independent copy). One-round sessions are
    // held to the same rule.
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['open singles', {}],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
      ['pro doubles men', { hyroxFormat: 'pro_doubles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>],
    ];
    const injuries: Array<['upper' | 'lower', number]> = [['lower', 30], ['lower', 50], ['lower', 70], ['lower', 90], ['upper', 30], ['upper', 50], ['upper', 90]];
    let checked = 0; let oneRound = 0; let oneRoundCut = 0; let sideHeld = 0; let sidesDiffer = 0; let partialSets = 0;
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
          const share = (cap / 100) * own;
          const sideShare = (cap / 100) * sideSecOf(u, side);
          const { kept: want, fitsAny15 } = gateRule(u, upper, lower, access);
          const [g] = applyHyroxInjuryGates([u], inj, 0, access);
          checked++;
          if ((u.hyroxRounds ?? 1) === 1) oneRound++;
          if (!g) {
            // Left out only when nothing it may keep runs 15 min.
            if (want) off.push(`${label}: left out, ${sigOf(want)} runs ${want.estimatedDurationMin} min`);
            continue;
          }
          const work = hyroxSessionWorkMin(g);
          if ((u.hyroxRounds ?? 1) === 1 && work < own - 1e-6) oneRoundCut++;
          if ((g.hyroxComponents ?? []).some(c => c.raceFraction != null && c.raceFraction < 0.25 - 1e-9)) partialSets++;
          if (!want || Math.abs(work - hyroxSessionWorkMin(want)) > 1e-6 || Math.abs(sideSecOf(g, side) - sideSecOf(want, side)) > 1e-6) off.push(`${label}: kept ${sigOf(g)} (${work.toFixed(1)} of ${own.toFixed(1)} min), the rule keeps ${sigOf(want)}`);
          // Within the shares whenever a shape that fits runs 15 min.
          if (fitsAny15) {
            if (work > share + 1e-6) off.push(`${label}: ${work.toFixed(1)} min above the ${share.toFixed(1)}-min share`);
            if (sideSecOf(u, side) > 0) {
              sideHeld++;
              if (sideSecOf(g, side) > sideShare + 1e-6) off.push(`${label}: ${side} body ${sideSecOf(g, side)} s above the ${sideShare.toFixed(0)}-s share (${sigOf(u)} to ${sigOf(g)})`);
            }
          }
          expect(g.hyroxSpec?.warmup, label).toBeDefined();
          expect(g.hyroxSpec?.finisher, label).toBeUndefined();
          expect(g.estimatedDurationMin ?? 0, label).toBeGreaterThanOrEqual(15);
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
    expect(sideHeld).toBeGreaterThan(300);
    expect(sidesDiffer).toBeGreaterThan(100);
    // One-round sessions (the doubles station floor's shape) lose station
    // work too, and partial sets reach kept sessions.
    expect(oneRound).toBeGreaterThan(100);
    expect(oneRoundCut).toBeGreaterThan(0);
    expect(partialSets).toBeGreaterThan(100);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);

  it('a shoulder restriction cuts the SkiErg before the sled push, a knee restriction the sled push before the SkiErg (review round 4: total_beginner 12 w W2 went from row, farmers carry, SkiErg and sled push x4 to row and SkiErg x2 under upper body 50)', () => {
    const s = build('total_beginner', HYROX_HOURS_RANGE.total_beginner.default, 12);
    const u = prescribed(s.wks[1]).find(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density');
    expect(u).toBeDefined();
    const types = (w: Workout | undefined) => (w?.hyroxComponents ?? []).map(c => c.type);
    expect(types(u)).toEqual(expect.arrayContaining(['ski_erg', 'sled_push']));
    for (const cap of [30, 50, 70]) {
      const [up] = applyHyroxInjuryGates([u!], { active: true, runCapacity: 100, upperLoadCapacity: cap, lowerLoadCapacity: 100 } as unknown as InjuryState);
      const [lo] = applyHyroxInjuryGates([u!], { active: true, runCapacity: 100, upperLoadCapacity: 100, lowerLoadCapacity: cap } as unknown as InjuryState);
      if (up && !types(up).includes('sled_push')) expect(types(up), `upper ${cap}`).not.toContain('ski_erg');
      if (lo && !types(lo).includes('ski_erg')) expect(types(lo), `lower ${cap}`).not.toContain('sled_push');
      if (up) expect(sideShareOf(u!, up, 'ski_erg'), `upper ${cap}`).toBeLessThanOrEqual(cap / 100 + 1e-6);
      if (lo) expect(sideShareOf(u!, lo, 'sled_push'), `lower ${cap}`).toBeLessThanOrEqual(cap / 100 + 1e-6);
    }
  }, 60000);

  it('keeps no less of the restricted side\'s station work as its capacity rises from 10 to 100 while the kept shape is within the shares, and at most twice its work at 90 at clearance, singles, doubles and pro (review round 5: with the most station work first, 189 of 229 open singles sessions holding lower-body stations kept less of them at some higher capacity; review round 6: doubles sessions kept none of the restricted side\'s work from 50 to 90 and got the whole set back at 100, 42 of 101 open doubles sessions under upper body)', () => {
    const variants: Array<[string, Partial<OnboardingState>, boolean]> = [
      ['open singles', {}, false],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>, true],
      ['pro singles men', { hyroxFormat: 'pro_singles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>, false],
      ['pro doubles men', { hyroxFormat: 'pro_doubles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>, true],
    ];
    const caps = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    let checked = 0; let keptAt90 = 0; let fallbacks = 0;
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
              // The restricted side's work at each capacity (a session left
              // out holds none; at 100 the gate keeps the session whole), and
              // whether the kept shape is within the shares (the smallest
              // shape, kept when none is that small, is not: open question 22).
              const gs = caps.map(cap => (cap >= 100 ? u : applyHyroxInjuryGates([u], {
                active: true, runCapacity: 100,
                upperLoadCapacity: side === 'upper' ? cap : 100, lowerLoadCapacity: side === 'lower' ? cap : 100,
              } as unknown as InjuryState, 0, access)[0]));
              const kept = gs.map(g => sideSecOf(g, side));
              const within = gs.map((g, k) => !g || caps[k] >= 100
                || (hyroxSessionWorkMin(g) <= (caps[k] / 100) * hyroxSessionWorkMin(u) + 1e-6 && kept[k] <= (caps[k] / 100) * all + 1e-6));
              fallbacks += within.filter(x => !x).length;
              let last = -1;
              for (let k = 0; k < caps.length; k++) {
                if (!within[k]) continue;
                if (last >= 0 && kept[k] < kept[last] - 1e-6) falls.push(`${label}: ${kept[last]} s at ${caps[last]}, ${kept[k]} s at ${caps[k]}`);
                last = k;
              }
              // At clearance the restricted side's work at most doubles from
              // 90; a singles session kept at 90 always holds some of it.
              if (kept[8] > 0) {
                keptAt90++;
                if (kept[9] > 2 * kept[8] + 1e-6) falls.push(`${label}: ${kept[8]} s at 90, ${kept[9]} s at 100`);
              } else if (gs[8] && !doubles) falls.push(`${label}: kept at 90 with none of its ${side}-body work`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(keptAt90).toBeGreaterThan(checked * 0.7);
    expect(fallbacks).toBeGreaterThan(0);
    expect(falls.slice(0, 10)).toEqual([]);
  }, 300000);

  it('holds each restricted side to the share at its own capacity, both sides restricted unequally or equally, the lower capacity cut first, both sides first at a tie (review round 5: round 4 held the lower-capacity side only, so at upper body 50 and lower body 70 open singles sessions kept lower-body stations above 70% in 20 of 204 sessions where a shape held both shares; review round 6: equal capacities held the session share only, open singles at 70/70 kept upper-body stations above 70% in 91 of 123 kept sessions)', () => {
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
              const { kept: want, fitsAny15 } = gateRule(u, up, lo, access);
              const [g] = applyHyroxInjuryGates([u], { active: true, runCapacity: 100, upperLoadCapacity: up, lowerLoadCapacity: lo } as unknown as InjuryState, 0, access);
              if (!!g !== !!want || (g && want && (Math.abs(hyroxSessionWorkMin(g) - hyroxSessionWorkMin(want)) > 1e-6
                || Math.abs(sideSecOf(g, 'upper') - sideSecOf(want, 'upper')) > 1e-6 || Math.abs(sideSecOf(g, 'lower') - sideSecOf(want, 'lower')) > 1e-6))) {
                off.push(`${label}: kept ${sigOf(g)}, the rule keeps ${sigOf(want)}`);
              }
              if (!g) continue;
              if (fitsAny15) {
                held++;
                if (up === lo) equalHeld++;
                if (sideSecOf(g, 'upper') > (up / 100) * sideSecOf(u, 'upper') + 1e-6 || sideSecOf(g, 'lower') > (lo / 100) * sideSecOf(u, 'lower') + 1e-6) off.push(`${label}: ${sigOf(u)} to ${sigOf(g)} above a side's share`);
              }
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
    expect(sledShape).toBeGreaterThan(0);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);

  it('one side swept from 10 to 100 in steps of 5 with the other at 50: each side within its own share whenever a shape that fits runs 15 min, and the swept side\'s work never falls while it is the lower capacity and the kept shape is within the shares (review round 6: through equality the swept side\'s work fell at a higher capacity in 38 of 134 open singles and 22 of 134 open doubles sessions under upper body, 56 of 229 and 16 of 234 under lower body)', () => {
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
                const within = !g || (hyroxSessionWorkMin(g) <= (Math.min(up, lo) / 100) * hyroxSessionWorkMin(u) + 1e-6
                  && sideSecOf(g, 'upper') <= (up / 100) * sideSecOf(u, 'upper') + 1e-6 && sideSecOf(g, 'lower') <= (lo / 100) * sideSecOf(u, 'lower') + 1e-6);
                if (g && gateRule(u, up, lo, access).fitsAny15) {
                  held++;
                  if (!within) off.push(`${label}: ${sigOf(u)} to ${sigOf(g)} above a share`);
                }
                if (cap >= 50 || !within) continue;
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
  /** The warm-up rule, an independent copy (review rounds 4 to 6): each way
   *  the athlete can warm up has a capacity of its own (a jog the run
   *  capacity, the SkiErg the upper body's, the Row Erg the lower of the two
   *  sides', HYROX_STATION_REGION's full-body row); the warm-up takes the
   *  highest, ties in the decision's order (an upper-body restriction: Row
   *  Erg, jog, SkiErg; a lower-body one: SkiErg, jog, Row Erg; equal: the
   *  planned way first), and below 100 keeps that capacity's share of 10 min
   *  (at least 1, at 0 none), except an erg under equal restrictions (whole,
   *  open question 25). */
  const warmRule = (planned: Mode, run: number, upper: number, lower: number, access: NonNullable<SimulatorState['hyroxConfig']>['stationAccess']): { mode: Mode; min: number } => {
    const capOf = (m: Mode) => (m === 'run' ? run : m === 'ski_erg' ? upper : m === 'row_erg' ? Math.min(upper, lower) : 100);
    const restricted = upper < lower ? 'upper' : lower < upper ? 'lower' : null;
    const order: Mode[] = restricted === 'upper' ? ['row_erg', 'run', 'ski_erg'] : restricted === 'lower' ? ['ski_erg', 'run', 'row_erg'] : [planned, 'run', 'row_erg', 'ski_erg'];
    const has = (m: Mode) => m === planned || m === 'run' || (m === 'ski_erg' && access.skiErg) || (m === 'row_erg' && access.rowErg);
    const ways = [...order, planned].filter(has);
    const top = Math.max(...ways.map(capOf));
    const mode = ways.find(m => capOf(m) === top) as Mode;
    const c = capOf(mode);
    const whole = c >= 100 || (restricted == null && mode !== 'run');
    return { mode, min: whole ? 10 : c <= 0 ? 0 : Math.min(10, Math.max(1, Math.round(c / 10))) };
  };

  it('takes the way with the highest capacity of its own (a jog the run capacity, the SkiErg the upper body\'s, the Row Erg the lower of the two sides\'), ties in the decision\'s order, and keeps that capacity\'s share; never opens a kept session with a whole SkiErg or Row Erg warm-up under an upper-body restriction, one-sided or two-sided (review round 5: open singles men under upper body 30, 157 kept sessions opened with 10 min on the SkiErg; review round 6: under the neck default every kept session opened with a whole Row Erg warm-up, and under two restricted sides the warm-up moved to the injured side\'s erg past equality)', () => {
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['both ergs', {}],
      ['SkiErg only', { hyroxHasRowErg: false } as Partial<OnboardingState>],
      ['Row Erg only', { hyroxHasSkiErg: false } as Partial<OnboardingState>],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
    ];
    // [run, upper body, lower body]: one-sided at 30 to 90 with run 100 and
    // 50; the neck and chest_ribs defaults (run 50, upper 50 / upper 30 and
    // lower 50); the elbow default (run 100, lower 50) with upper body
    // through equality; equal sides with run 100 and 50.
    const states: Array<[number, number, number]> = [];
    for (const cap of [30, 50, 70, 90]) for (const run of [100, 50]) states.push([run, cap, 100], [run, 100, cap]);
    states.push([50, 50, 100], [50, 30, 50], [100, 45, 50], [100, 50, 50], [100, 55, 50], [50, 50, 50]);
    let kept = 0; let moved = 0; let shared = 0;
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
              if (!(g.modReason ?? '').includes(` cut to ${want.min} min.`)) off.push(`${label}: no cut note`);
            }
            if (upper < 100 && upper < lower && wu && wu.mode !== 'run' && wu.min >= 10) off.push(`${label}: a whole erg warm-up under an upper-body restriction`);
            expect(g.estimatedDurationMin ?? 0, label).toBeGreaterThanOrEqual(15);
          }
        }
      }
    }
    expect(kept).toBeGreaterThan(3000);
    expect(moved).toBeGreaterThan(1000);
    expect(shared).toBeGreaterThan(300);
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
  it('follows the run capacity: with neither erg, no jog under run capacity 0 (the first round at easy effort serves as the warm-up, and the card says so), a 5-min jog under 50, every station session at 15 min or more, singles and doubles (review round 4: under run capacity 0, 175 of 175 station sessions opened with a 10-min jog; review round 5: no warm-up at all, and no doubles case)', () => {
    const NO_ERGS = { hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>;
    const cases: Array<[number, number]> = [[0, 100], [0, 50], [50, 100], [50, 50]];
    let ungatedJogs = 0; let sessions = 0; let stationOnly = 0;
    const off: string[] = [];
    const DOUBLES = { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>;
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
              if (!g) {
                if (Math.round(hyroxSessionWorkMin(u) + runCap / 10) >= 15) off.push(`${band} ${len}w ${u.n} run ${runCap}: left out with ${hyroxSessionWorkMin(u).toFixed(1)} min of station work`);
                continue;
              }
              if (hyroxSessionWorkMin(g) !== hyroxSessionWorkMin(u)) off.push(`${band} ${len}w ${u.n} run ${runCap}: station work changed`);
              expect(g.modReason ?? '').toMatch(/^Run capacity /);
              if (runCap === 0) {
                expect(g.modReason ?? '').toContain('Take the first round at easy effort as the warm-up.');
                // Written into the session: round 1's sets at the easy RPE,
                // in its spec, its text and its MTL (linear in the RPE).
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
              if (runCap === 50 && !(wu?.mode === 'run' && wu.min === 5)) off.push(`${label}: warm-up ${wu ? `${wu.min} min ${wu.mode}` : 'none'}`);
              if (Math.round(hyroxSessionWorkMin(w) + (wu?.min ?? 0)) < 15) off.push(`${label}: ${hyroxSessionWorkMin(w).toFixed(1)} min of station work and ${wu?.min ?? 0} min of warm-up`);
            }
          }
        }
      }
    }
    expect(ungatedJogs).toBeGreaterThan(150);
    expect(stationOnly).toBeGreaterThan(300);
    expect(sessions).toBeGreaterThan(300);
    expect(off.slice(0, 10)).toEqual([]);
  }, 120000);
  it('the 15-min station floor counts no warm-up for a session whose round 1 is the warm-up (run capacity 0, no erg), so a cut never leaves it with 5 min of station work (review round 6: the floor read the planned 10 min when the gates removed the warm-up)', () => {
    let checked = 0;
    for (const band of BANDS) {
      const s = build(band, HYROX_HOURS_RANGE[band].default, 12, { hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>);
      const inj = { active: true, runCapacity: 0, upperLoadCapacity: 100, lowerLoadCapacity: 100 } as unknown as InjuryState;
      for (const u of s.wks.flatMap(wk => prescribed(wk)).filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density')) {
        const [g] = applyHyroxInjuryGates([u], inj);
        if (!g) continue;
        expect(g.hyroxSpec?.warmupRound).toBe(true);
        // Every cut of rounds and stations: the floor holds only when the
        // station work alone runs 15 min.
        for (let st = g; ;) {
          for (let r = st.hyroxRounds ?? 1; r >= 1; r--) {
            const x = withHyroxRounds(st, r);
            checked++;
            expect(holdsStationFloor(x), `${band} ${u.n} ${hyroxSessionWorkMin(x).toFixed(1)} min`).toBe(Math.round(hyroxSessionWorkMin(x)) >= 15);
          }
          const cut = hyroxStationToCut(st);
          const next = cut ? withoutHyroxStation(st, cut) : st;
          if (next === st) break;
          st = next;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  }, 120000);
});
