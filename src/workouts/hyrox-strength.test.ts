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
 *     doubles (review round 3).
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
import { generateHyroxPlanDetailed, regenerateHyroxWeeksFrom, applyHyroxInjuryGates } from './plan_engine.hyrox';
import { hyroxSessionWorkMin, withHyroxRounds, hyroxRunLengthKm, withoutHyroxStation, hyroxStationToCut } from './hyrox-generators';
import { hyroxSessionWalk } from './hyrox-session-shape';
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

  it('keeps the most station work within the capacity\'s share of its own, cutting stations as well as rounds, the restricted side first, singles and doubles, lower body at 30, 50 and 70 and upper body at 30 and 50 (review round 3: whole rounds alone kept a median 43 to 45% at every capacity, and a one-round doubles session all of it; review round 4: a shoulder restriction cut the sled push and kept the SkiErg)', () => {
    // Every combination of the session's stations (cut in hyroxStationToCut
    // order with the restricted side's stations first, then the full-body
    // ones, then the other side's, HYROX_STATION_REGION; down to
    // MIN_CIRCUIT_STATIONS) and rounds (down to one): the session keeps the
    // one with the most station work at or under the capacity's share of its
    // own station work, the restricted side's stations also at or under the
    // share of their own, or the smallest when none is that small, keeps its
    // warm-up and runs 15 min or more, or leaves the week. One-round sessions
    // are held to the same rule.
    const variants: Array<[string, Partial<OnboardingState>]> = [
      ['open singles', {}],
      ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>],
      ['pro doubles men', { hyroxFormat: 'pro_doubles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>],
    ];
    const injuries: Array<['upper' | 'lower', number]> = [['lower', 30], ['lower', 50], ['lower', 70], ['upper', 30], ['upper', 50]];
    const rankFor = (side: 'upper' | 'lower') => (st: HyroxStation): number => {
      const region = HYROX_STATION_REGION[st];
      return region === side ? 0 : region === 'full' ? 1 : 2;
    };
    const candidates = (u: Workout, side: 'upper' | 'lower'): Workout[] => {
      const out: Workout[] = [];
      for (let st = u; ;) {
        for (let r = st.hyroxRounds ?? 1; r >= 1; r--) out.push(withHyroxRounds(st, r));
        const cut = hyroxStationToCut(st, rankFor(side));
        const next = cut ? withoutHyroxStation(st, cut) : st;
        if (next === st) break;
        st = next;
      }
      return out;
    };
    /** Work seconds of a session's stations on one side. */
    const sideSec = (w: Workout, side: 'upper' | 'lower') => hyroxSessionWalk(w)
      .filter(x => x.component.type !== 'run' && HYROX_STATION_REGION[x.component.type as HyroxStation] === side)
      .reduce((a, x) => a + (x.component.durationSec ?? 0), 0);
    const sig = (w: Workout | undefined) => (w ? `${(w.hyroxComponents ?? []).map(c => c.type).join('+')} x${w.hyroxRounds}` : 'left out');
    let checked = 0; let oneRound = 0; let oneRoundCut = 0; let sideHeld = 0; let sidesDiffer = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      const sessions: Array<[string, Workout]> = [];
      for (const band of BANDS) {
        for (const len of [12, 16]) {
          const s = build(band, HYROX_HOURS_RANGE[band].default, len, over);
          for (const wk of s.wks) {
            for (const u of prescribed(wk)) {
              if (u.t === 'hyrox_station_technique' || u.t === 'hyrox_station_density') sessions.push([`${name} ${band} ${len}w W${wk.w} ${u.n}`, u]);
            }
          }
        }
      }
      for (const [side, cap] of injuries) {
        const inj = {
          active: true, runCapacity: 100, location: side === 'upper' ? 'shoulder' : 'knee',
          upperLoadCapacity: side === 'upper' ? cap : 100, lowerLoadCapacity: side === 'lower' ? cap : 100,
        } as unknown as InjuryState;
        for (const [where, u] of sessions) {
          const label = `${side} ${cap} ${where}`;
          const own = hyroxSessionWorkMin(u);
          const share = (cap / 100) * own;
          const sideShare = (cap / 100) * sideSec(u, side);
          const all = candidates(u, side);
          const fits = all.filter(c => hyroxSessionWorkMin(c) <= share + 1e-6 && sideSec(c, side) <= sideShare + 1e-6).map(hyroxSessionWorkMin);
          const want = fits.length > 0 ? Math.max(...fits) : Math.min(...all.map(hyroxSessionWorkMin));
          const [g] = applyHyroxInjuryGates([u], inj);
          checked++;
          if ((u.hyroxRounds ?? 1) === 1) oneRound++;
          if (!g) {
            // Left out only when the kept station work and the warm-up
            // run under 15 min.
            if (Math.round(want + (u.hyroxSpec?.warmup?.min ?? 0)) >= 15) off.push(`${label}: left out with ${want.toFixed(1)} min of station work`);
            continue;
          }
          const work = hyroxSessionWorkMin(g);
          if ((u.hyroxRounds ?? 1) === 1 && work < own - 1e-6) oneRoundCut++;
          if (Math.abs(work - want) > 1e-6) off.push(`${label}: ${work.toFixed(1)} of ${own.toFixed(1)} min, the best within ${share.toFixed(1)} is ${want.toFixed(1)}`);
          if (fits.length > 0 && work > share + 1e-6) off.push(`${label}: ${work.toFixed(1)} min above the ${share.toFixed(1)}-min share`);
          // The restricted side's stations stay within the share of their
          // own whenever a shape allows it.
          if (fits.length > 0 && sideSec(u, side) > 0) {
            sideHeld++;
            if (sideSec(g, side) > sideShare + 1e-6) off.push(`${label}: ${side} body ${sideSec(g, side)} s above the ${sideShare.toFixed(0)}-s share (${sig(u)} to ${sig(g)})`);
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
        for (const [, u] of sessions) if (sig(applyHyroxInjuryGates([u], up)[0]) !== sig(applyHyroxInjuryGates([u], lo)[0])) sidesDiffer++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(sideHeld).toBeGreaterThan(300);
    expect(sidesDiffer).toBeGreaterThan(100);
    // One-round sessions (the doubles station floor's shape) lose station
    // work too.
    expect(oneRound).toBeGreaterThan(100);
    expect(oneRoundCut).toBeGreaterThan(0);
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
});

describe('a station session\'s jog warm-up under a run restriction', () => {
  it('follows the run capacity: with neither erg, no jog under run capacity 0, a 5-min jog under 50, every station session at 15 min or more (review round 4: under run capacity 0, 175 of 175 station sessions opened with a 10-min jog)', () => {
    const NO_ERGS = { hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>;
    const cases: Array<[number, number]> = [[0, 100], [0, 50], [50, 100], [50, 50]];
    let ungatedJogs = 0; let sessions = 0; let stationOnly = 0;
    const off: string[] = [];
    for (const band of BANDS) {
      for (const len of [12, 16]) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, len, NO_ERGS);
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
              const label = `${band} ${len}w W${wk?.w} ${w.n} run ${runCap} lower ${lower}`;
              const wu = w.hyroxSpec?.warmup;
              if (runCap === 0 && wu) off.push(`${label}: ${wu.min}-min ${wu.mode} warm-up`);
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
});
