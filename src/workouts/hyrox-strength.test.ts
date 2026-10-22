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
import type { AbilityBand, HyroxComponent, HyroxStation } from '@/types/triathlon';
import {
  HYROX_HOURS_RANGE, HYROX_WEEKLY_STRUCTURE, HYROX_STRENGTH_SESSIONS, HYROX_RUN_SHARE, HYROX_RUN_FLOOR_MIN,
  HYROX_STRENGTH_BLOCK_MIN, hyroxTier, hyroxBaseMultiplier,
} from '@/constants/hyrox-constants';
import { isHyroxDeloadWeek } from './plan_engine';
import { generateHyroxPlanDetailed, regenerateHyroxWeeksFrom, applyHyroxInjuryGates, holdsStationFloor, HYROX_MIN_STATION_SESSION_MIN } from './plan_engine.hyrox';
import { hyroxSessionWorkMin, withHyroxRounds, hyroxRunLengthKm, withoutHyroxStation, hyroxStationToCut, withHyroxSessionParts, hyroxWarmupOn, isHyroxEasyErg, generateHyroxEasyErg } from './hyrox-generators';
import { hyroxSessionWalk, hyroxComponentSets, hyroxComponentRounds, hyroxSessionPlannedTss } from './hyrox-session-shape';
import { plannedTssPerMin } from '@/constants/sports';
import { HYROX_EASY_RPE, HYROX_SESSION_WARMUP_MIN } from '@/constants/hyrox-constants';
import { computeComponentMTL } from '@/calculations/mtl';
import { HYROX_STATION_REGION } from '@/calculations/hyrox-injury';
import type { InjuryState } from '@/types/injury';
import { planTrainingWeeks } from './race-week-layout';
import { isHyroxLongRun, isHyroxStrengthSession, isHighIntensity, isEccentricSession } from './scheduler.hyrox';
import { injuryStrengthDecision } from './injury-strength';

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
  return Math.round(hyroxSessionWorkMin(c) - roundOne + HYROX_SESSION_WARMUP_MIN) >= HYROX_MIN_STATION_SESSION_MIN;
};

type Caps = [number, number, number];
type Access = NonNullable<SimulatorState['hyroxConfig']>['stationAccess'];
type Mode = NonNullable<NonNullable<Workout['hyroxSpec']>['warmup']>['mode'];
/** An injury at [run, upper body, lower body] capacities. */
const injOf = ([run, up, lo]: Caps, location = 'other') => ({ active: true, runCapacity: run, upperLoadCapacity: up, lowerLoadCapacity: lo, location } as unknown as InjuryState);
const isCircuitW = (w: Workout | undefined) => !!w && (w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density') && !!w.hyroxSpec;
/** A station's capacity (HYROX_STATION_REGION: its side's; a full-body
 *  station's, the lower of the two). */
const capOfStation = (st: HyroxStation, up: number, lo: number) => {
  const r = HYROX_STATION_REGION[st];
  return r === 'upper' ? up : r === 'lower' ? lo : Math.min(up, lo);
};
/** Work seconds of a session's full-body stations. */
const fullSecOf = (w: Workout | undefined) => (w ? hyroxSessionWalk(w)
  .filter(x => x.component.type !== 'run' && HYROX_STATION_REGION[x.component.type as HyroxStation] === 'full')
  .reduce((a, x) => a + (x.component.durationSec ?? 0), 0) : 0);
const amountOf = (c: HyroxComponent) => (typeof c.reps === 'number' ? c.reps : (c.distanceM ?? 0));
/** Seconds of a run text span: "12 min 30 s", "5 min", "45 s". */
const spanSec = (x: string): number => {
  const m = /^(?:(\d+) min)?(?: ?(\d+) s)?$/.exec(x.trim());
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : NaN;
};
/** The minutes a run's text prescribes (generateHyroxRun's templates; a
 *  race-pace rep at its pace), or null for a text it does not match. */
const runTextMin = (w: Workout): number | null => {
  const d = w.d ?? '';
  let m = /^(\d+) min easy at /.exec(d);
  if (m) return Number(m[1]);
  m = /^(.+?) easy warm-up\. (.+?) at (?:threshold pace|HYROX race pace) \(~\d+:\d+\/km\), comfortably hard, short phrases only\. (.+?) easy cool-down\.$/.exec(d);
  if (m) return (spanSec(m[1]) + spanSec(m[2]) + spanSec(m[3])) / 60;
  m = /^(.+?) easy warm-up\. (\d+) × (.+?) at about \d+% of max HR(?: \(~\d+ bpm\))?, (.+?) easy jog between reps\. (.+?) easy cool-down\.$/.exec(d);
  if (m) { const n = Number(m[2]); return (spanSec(m[1]) + n * spanSec(m[3]) + (n - 1) * spanSec(m[4]) + spanSec(m[5])) / 60; }
  m = /^(.+?) easy warm-up\. (\d+) × (\d+(?:\.\d+)?) (m|km) at HYROX race pace \(~(\d+):(\d+)\/km\), (.+?) rest between reps\. (.+?) easy cool-down\.$/.exec(d);
  if (m) {
    const n = Number(m[2]); const km = Number(m[3]) / (m[4] === 'm' ? 1000 : 1); const pace = Number(m[5]) * 60 + Number(m[6]);
    return (spanSec(m[1]) + n * km * pace + (n - 1) * spanSec(m[7]) + spanSec(m[8])) / 60;
  }
  return null;
};

/** MTL a minute of a warm-up way at the easy RPE (mtl.ts). */
const warmMtlPerMin = (m: Mode) => computeComponentMTL(1, HYROX_EASY_RPE, m === 'run' ? 'run_easy' : m);
/** The warm-up rule, an independent copy (review rounds 4 to 7, injury gate
 *  v2 and its review): each way the athlete can warm up has a capacity of
 *  its own (a jog the run capacity, the SkiErg the upper body's, the Row Erg
 *  the lower of the two sides', HYROX_STATION_REGION's full-body row); among
 *  the ways that carry the planned way's MTL a minute (an erg moves only to
 *  the other erg, a jog stays a jog) the warm-up takes the highest, ties in
 *  the decision's order (an upper-body restriction: Row Erg, SkiErg; a
 *  lower-body one: SkiErg, Row Erg; equal: the planned way first), and below
 *  100 keeps that capacity's share of the planned minutes (at least 1, at 0
 *  none), equal restrictions too. */
const warmRule = (planned: Mode, run: number, upper: number, lower: number, access: Access): { mode: Mode; min: number } => {
  const capOf = (m: Mode) => (m === 'run' ? run : m === 'ski_erg' ? upper : m === 'row_erg' ? Math.min(upper, lower) : 100);
  const restricted = upper < lower ? 'upper' : lower < upper ? 'lower' : null;
  const order: Mode[] = restricted === 'upper' ? ['row_erg', 'run', 'ski_erg'] : restricted === 'lower' ? ['ski_erg', 'run', 'row_erg'] : [planned, 'run', 'row_erg', 'ski_erg'];
  const has = (m: Mode) => m === planned || m === 'run' || (m === 'ski_erg' && access.skiErg) || (m === 'row_erg' && access.rowErg);
  const ways = [...order, planned].filter(m => has(m) && warmMtlPerMin(m) === warmMtlPerMin(planned));
  const top = Math.max(...ways.map(capOf));
  const mode = ways.find(m => capOf(m) === top) as Mode;
  const c = capOf(mode);
  const W = HYROX_SESSION_WARMUP_MIN;
  return { mode, min: c >= 100 ? W : c <= 0 ? 0 : Math.min(W, Math.max(1, Math.round((W * c) / 100))) };
};

/**
 * The injury gate's station-session rule (injury gate v2, 2026-10-22), an
 * independent copy: every set of a station at its side's capacity share of
 * its amount, rounded down to a whole metre or rep (a station with none left
 * leaves; the session's rounds end at the last round a station left holds);
 * the finisher at its erg's share, rounded down to the minute; the warm-up
 * per warmRule (none left: round 1 at easy effort is the warm-up). The
 * session stays when no station's side is at 0 and its station work with the
 * planned 10-min warm-up holds 15 min (after round 1 when round 1 is the
 * warm-up), or when nothing of its station work is cut and the plan holds it
 * under the floor, unless round 1 as its warm-up leaves it one round.
 */
function ruleV2(u: Workout, [run, up, lo]: Caps, access: Access): { kept: boolean; amounts: Map<string, number>; rounds: number; warm: { mode: Mode; min: number }; finisherMin: number } {
  const rounds0 = Math.max(1, u.hyroxRounds ?? 1);
  const amounts = new Map<string, number>();
  const left: HyroxComponent[] = [];
  let cut = false; let zero = false;
  for (const c of u.hyroxComponents ?? []) {
    if (c.type === 'run') { left.push(c); continue; }
    const cap = capOfStation(c.type as HyroxStation, up, lo);
    if (cap <= 0) zero = true;
    if (cap >= 100) { amounts.set(c.type, amountOf(c)); left.push(c); continue; }
    cut = true;
    const amount = Math.floor(amountOf(c) * (cap / 100) + 1e-9);
    if (amount < 1) continue;
    const ratio = amount / amountOf(c);
    amounts.set(c.type, amount);
    left.push({ ...c, durationSec: Math.floor((c.durationSec ?? 0) * ratio + 1e-9) });
  }
  const rounds = Math.min(rounds0, Math.max(1, ...left.map(c => { const rs = hyroxComponentRounds(c, rounds0); return rs.length > 0 ? rs[rs.length - 1] : 0; })));
  const warm = warmRule(u.hyroxSpec!.warmup!.mode, run, up, lo, access);
  const shape = { ...u, hyroxComponents: left, hyroxRounds: rounds, hyroxSpec: { ...u.hyroxSpec!, warmupRound: warm.min <= 0 } } as Workout;
  const oneRound = warm.min <= 0 && rounds <= 1;
  const kept = !zero && (floorHolds(shape) || (!cut && !floorHolds(u) && !oneRound));
  const f = u.hyroxSpec!.finisher;
  const finisherMin = f ? Math.floor((f.min * Math.min(100, capOfStation(f.station, up, lo))) / 100 + 1e-9) : 0;
  return { kept, amounts, rounds, warm, finisherMin };
}

/** Every station session of plans over the bands' default and lowest hours,
 *  12 and 16 weeks, for the given variants, with the athlete's ergs. */
const stationSessionsOf = (variants: Array<[string, Partial<OnboardingState>]>, lens = [12, 16]) => {
  const out: Array<{ label: string; u: Workout; access: Access }> = [];
  for (const [name, over] of variants) {
    for (const band of BANDS) {
      for (const h of [HYROX_HOURS_RANGE[band].min, HYROX_HOURS_RANGE[band].default].filter((x, i, a) => a.indexOf(x) === i)) {
        for (const len of lens) {
          const s = build(band, h, len, over);
          const access = s.hyroxConfig!.stationAccess;
          for (const wk of s.wks) for (const u of prescribed(wk)) if (isCircuitW(u)) out.push({ label: `${name} ${band} ${h}h ${len}w W${wk.w} ${u.n}`, u, access });
        }
      }
    }
  }
  return out;
};
const V_SINGLES: [string, Partial<OnboardingState>] = ['open singles men', { biologicalSex: 'male', hyroxDivision: 'men' } as Partial<OnboardingState>];
const V_DOUBLES: [string, Partial<OnboardingState>] = ['open doubles mixed', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' } as Partial<OnboardingState>];
const V_PRO_DOUBLES: [string, Partial<OnboardingState>] = ['pro doubles men', { hyroxFormat: 'pro_doubles', hyroxDivision: 'men', biologicalSex: 'male' } as Partial<OnboardingState>];
const V_SKI: [string, Partial<OnboardingState>] = ['SkiErg only open singles', { biologicalSex: 'male', hyroxHasRowErg: false } as Partial<OnboardingState>];
const V_ROW: [string, Partial<OnboardingState>] = ['Row Erg only open doubles', { hyroxFormat: 'open_doubles', hyroxDivision: 'mixed', hyroxHasSkiErg: false } as Partial<OnboardingState>];
const V_NOERG: [string, Partial<OnboardingState>] = ['no-erg open singles', { biologicalSex: 'male', hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>];

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

describe('injury gate v2: a station session at its capacities\' shares of the uninjured session', () => {
  it('every set at its side\'s share rounded down, the finisher at its erg\'s, the warm-up on the way with the highest capacity, and kept when it holds the 15-min floor with the planned warm-up: singles, doubles, pro, one-erg and no-erg variants, one-sided, equal and unequal restrictions at run 100, 50 and 0 (an independent copy of the rule, ruleV2)', () => {
    const sessions = stationSessionsOf([V_SINGLES, V_DOUBLES, V_PRO_DOUBLES, V_SKI, V_ROW, V_NOERG], [12]);
    const states: Caps[] = [];
    for (const run of [100, 50, 0]) for (const c of [0, 5, 10, 30, 45, 50, 55, 70, 90, 95]) states.push([run, c, 100], [run, 100, c], [run, c, c]);
    states.push([100, 30, 50], [100, 50, 30], [50, 30, 50], [100, 45, 50], [100, 55, 50], [50, 50, 55], [70, 50, 50], [100, 90, 40], [100, 100, 100]);
    let kept = 0; let left = 0; let partial = 0; let stationLeft = 0; let finisherCut = 0; let warmRound = 0;
    const off: string[] = [];
    for (const { label, u, access } of sessions) {
      for (const st of states) {
        const want = ruleV2(u, st, access);
        const [g] = applyHyroxInjuryGates([u], injOf(st), 0, access);
        const l = `${label} at ${st.join('/')}`;
        if (!!g !== want.kept) { off.push(`${l}: ${g ? 'kept' : 'left out'}, the rule ${want.kept ? 'keeps it' : 'leaves it out'}`); continue; }
        if (!g) { left++; continue; }
        kept++;
        const got = new Map((g.hyroxComponents ?? []).filter(c => c.type !== 'run').map(c => [c.type as string, amountOf(c)] as const));
        if ([...got.keys()].sort().join() !== [...want.amounts.keys()].sort().join()) off.push(`${l}: stations ${[...got.keys()].join(',')}, the rule ${[...want.amounts.keys()].join(',')}`);
        for (const [t, a] of want.amounts) if (got.get(t) !== a) off.push(`${l}: ${t} ${got.get(t)}, the rule ${a}`);
        if (want.amounts.size < (u.hyroxComponents ?? []).filter(c => c.type !== 'run').length) stationLeft++;
        if ([...want.amounts].some(([t, a]) => a < amountOf(u.hyroxComponents!.find(c => c.type === t)!))) partial++;
        if ((g.hyroxRounds ?? 1) !== want.rounds) off.push(`${l}: ${g.hyroxRounds} rounds, the rule ${want.rounds}`);
        // Each station kept keeps every set; its time and MTL follow its amount.
        for (const c of (g.hyroxComponents ?? []).filter(x => x.type !== 'run')) {
          const uc = u.hyroxComponents!.find(x => x.type === c.type)!;
          if (hyroxComponentSets(c, g.hyroxRounds ?? 1) !== hyroxComponentSets(uc, u.hyroxRounds ?? 1)) off.push(`${l}: ${c.type} lost a set`);
          const ratio = amountOf(c) / amountOf(uc);
          if ((c.durationSec ?? 0) !== Math.floor((uc.durationSec ?? 0) * ratio + 1e-9) || Math.abs(c.mtl - uc.mtl * ratio) > 1e-9) off.push(`${l}: ${c.type} time or MTL off its amount`);
        }
        const wu = g.hyroxSpec?.warmup;
        if (want.warm.min > 0 ? !(wu && wu.mode === want.warm.mode && wu.min === want.warm.min) : (!!wu || !g.hyroxSpec?.warmupRound)) {
          off.push(`${l}: warm-up ${wu ? `${wu.min} min ${wu.mode}` : g.hyroxSpec?.warmupRound ? 'round 1' : 'none'}, the rule ${want.warm.min} min ${want.warm.mode}`);
        }
        if (want.warm.min <= 0) warmRound++;
        if ((g.hyroxSpec?.finisher?.min ?? 0) !== want.finisherMin) off.push(`${l}: finisher ${g.hyroxSpec?.finisher?.min ?? 0} min, the rule ${want.finisherMin}`);
        if (want.finisherMin < (u.hyroxSpec?.finisher?.min ?? 0)) finisherCut++;
        // The injury's strength decision pauses or adapts strength: no block.
        if (g.hyroxSpec?.strength) off.push(`${l}: strength block kept`);
        if (g.id !== u.id || g.dayOfWeek !== u.dayOfWeek || g.t !== u.t) off.push(`${l}: id, day or type changed`);
      }
    }
    expect(sessions.length).toBeGreaterThan(400);
    expect(kept).toBeGreaterThan(5000);
    expect(left).toBeGreaterThan(1000);
    expect(partial).toBeGreaterThan(3000);
    expect(stationLeft).toBeGreaterThan(0);
    expect(finisherCut).toBeGreaterThan(100);
    expect(warmRound).toBeGreaterThan(50);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);

  it('holds each side\'s station work, the full-body work, the finisher and the warm-up to their capacities\' shares of the uninjured session, is never longer or above its planned TSS or MTL, and as any one capacity (run, upper body, lower body) rises by 5 a kept session stays and no station\'s amount, side\'s work, warm-up, finisher, length, planned TSS or MTL falls: one-sided, equal and unequal restrictions, the other side at 25, 50 and 75, run capacity swept at 100/100, 50/50 and 30/70 (v2 review: a jog in place of an erg warm-up raised MTL above the uninjured session in 1.3 to 2.1% of kept states and let it fall as a capacity rose)', () => {
    const all = stationSessionsOf([V_SINGLES, V_DOUBLES, V_ROW, V_NOERG], [12]);
    const seen = new Set<string>();
    const sessions = all.filter(x => { const k = JSON.stringify([x.u.hyroxComponents, x.u.hyroxRounds, x.u.hyroxSpec, x.access]); if (seen.has(k)) return false; seen.add(k); return true; });
    const steps = Array.from({ length: 21 }, (_, i) => 5 * i);
    const byKey = new Map<string, Caps>();
    const add = (c: Caps) => byKey.set(c.join('/'), c);
    for (const run of [0, 50, 100]) for (const c of steps) { add([run, c, 100]); add([run, 100, c]); add([run, c, c]); }
    for (const o of [25, 50, 75]) for (const c of steps) { add([100, c, o]); add([100, o, c]); }
    for (const [up, lo] of [[100, 100], [50, 50], [30, 70]]) for (const r of steps) add([r, up, lo]);
    const states = [...byKey.values()];
    const warmMin = (w: Workout) => w.hyroxSpec?.warmup?.min ?? 0;
    let kept = 0; let steppedUp = 0; let moved = 0;
    const off: string[] = [];
    for (const { label, u, access } of sessions) {
      const memo = new Map<string, Workout | undefined>();
      const gate = (c: Caps) => { const k = c.join('/'); if (!memo.has(k)) memo.set(k, applyHyroxInjuryGates([u], injOf(c), 0, access)[0]); return memo.get(k); };
      for (const st of states) {
        const g = gate(st);
        if (!g) continue;
        kept++;
        const [run, up, lo] = st;
        const l = `${label} at ${st.join('/')}`;
        // Shares of the uninjured session.
        if (sideSecOf(g, 'upper') > (up / 100) * sideSecOf(u, 'upper') + 1e-6) off.push(`${l}: upper body above its share`);
        if (sideSecOf(g, 'lower') > (lo / 100) * sideSecOf(u, 'lower') + 1e-6) off.push(`${l}: lower body above its share`);
        if (fullSecOf(g) > (Math.min(up, lo) / 100) * fullSecOf(u) + 1e-6) off.push(`${l}: full-body work above its share`);
        const fu = u.hyroxSpec?.finisher;
        if (fu && (g.hyroxSpec?.finisher?.min ?? 0) > (fu.min * capOfStation(fu.station, up, lo)) / 100 + 1e-9) off.push(`${l}: finisher above its share`);
        // The warm-up: its way's share of the planned minutes (warmRule).
        if (warmMin(g) !== warmRule(u.hyroxSpec!.warmup!.mode, run, up, lo, access).min || warmMin(g) > warmMin(u)) off.push(`${l}: warm-up ${warmMin(g)} min off its share`);
        if ((g.estimatedDurationMin ?? 0) > (u.estimatedDurationMin ?? 0)) off.push(`${l}: longer than the uninjured session`);
        if (hyroxSessionPlannedTss(g) > hyroxSessionPlannedTss(u) + 1e-6) off.push(`${l}: planned TSS above the uninjured session's`);
        if ((g.musculoTendonLoad ?? 0) > (u.musculoTendonLoad ?? 0) + 1e-6) off.push(`${l}: MTL above the uninjured session's`);
        const wg = g.hyroxSpec?.warmup; const wu0 = u.hyroxSpec!.warmup!;
        if (wg && wg.mode !== wu0.mode) {
          moved++;
          if ((wg.mode === 'run') !== (wu0.mode === 'run')) off.push(`${l}: warm-up moved from ${wu0.mode} to ${wg.mode}`);
          if (wg.mtl > (wu0.mtl * wg.min) / wu0.min + 1e-9) off.push(`${l}: warm-up MTL above the planned way's at its minutes`);
        }
        for (let d = 0; d < 3; d++) {
          if (st[d] >= 100) continue;
          const nx = [...st] as Caps;
          nx[d] = Math.min(100, nx[d] + 5);
          const h = gate(nx);
          const m = `${label}: ${st.join('/')} to ${nx.join('/')}`;
          if (!h) { off.push(`${m}: kept, then left out`); continue; }
          steppedUp++;
          for (const c of (g.hyroxComponents ?? []).filter(x => x.type !== 'run')) {
            const hc = (h.hyroxComponents ?? []).find(x => x.type === c.type);
            if (!hc || amountOf(hc) < amountOf(c)) off.push(`${m}: ${c.type} ${amountOf(c)} to ${hc ? amountOf(hc) : 0}`);
          }
          for (const [what, f] of [['upper body', (w: Workout) => sideSecOf(w, 'upper')], ['lower body', (w: Workout) => sideSecOf(w, 'lower')], ['full body', fullSecOf],
            ['station work', hyroxSessionWorkMin], ['warm-up', warmMin], ['finisher', (w: Workout) => w.hyroxSpec?.finisher?.min ?? 0],
            ['length', (w: Workout) => w.estimatedDurationMin ?? 0], ['planned TSS', hyroxSessionPlannedTss]] as Array<[string, (w: Workout) => number]>) {
            if (f(h) < f(g) - 1e-6) off.push(`${m}: ${what} ${f(g)} to ${f(h)}`);
          }
          if ((h.musculoTendonLoad ?? 0) < (g.musculoTendonLoad ?? 0) - 1e-6) off.push(`${m}: MTL ${g.musculoTendonLoad} to ${h.musculoTendonLoad}`);
        }
      }
    }
    expect(sessions.length).toBeGreaterThan(200);
    expect(kept).toBeGreaterThan(30000);
    expect(steppedUp).toBeGreaterThan(30000);
    expect(moved).toBeGreaterThan(1000);
    expect(off.slice(0, 10)).toEqual([]);
  }, 600000);

  it('the other sessions: runs at the run capacity\'s share, none at 0, quality runs too, their text, run component and MTL agreeing with the badge; easy erg work at its erg\'s side\'s share with its text; bricks and race simulations only with every capacity at 100; the assessment keeping each station whole at 100% and leaving out the rest, none with a side at 0', () => {
    const s = build('intermediate', 8, 18, V_SINGLES[1]);
    const ws = s.wks.flatMap(wk => prescribed(wk));
    const access = s.hyroxConfig!.stationAccess;
    const runs = ws.filter(w => w.discipline === 'run');
    expect(runs.some(w => w.t === 'hyrox_run_tempo')).toBe(true);
    expect(runs.some(w => w.t === 'hyrox_run_intervals')).toBe(true);
    let quality = 0;
    for (const run of [0, 35, 50, 100]) {
      for (const u of runs) {
        const [g] = applyHyroxInjuryGates([u], injOf([run, 100, 100]), 0, access);
        if (run === 0) { expect(g).toBeUndefined(); continue; }
        const f = run / 100;
        const label = `${u.n} at run ${run}: ${g!.estimatedDurationMin}m "${g!.d}"`;
        expect(g!.estimatedDurationMin, label).toBe(run >= 100 ? u.estimatedDurationMin : Math.max(1, Math.round((u.estimatedDurationMin ?? 0) * f)));
        expect(g!.t).toBe(u.t);
        // The run component and the session's MTL at the exact share.
        expect(hyroxRunLengthKm(g!), label).toBeCloseTo(hyroxRunLengthKm(u) * f, 9);
        expect(g!.musculoTendonLoad ?? 0, label).toBeCloseTo((u.musculoTendonLoad ?? 0) * f, 9);
        // The text says what the badge does.
        const implied = runTextMin(g!);
        expect(implied, label).not.toBeNull();
        expect(Math.abs((implied as number) - (g!.estimatedDurationMin ?? 0)), label).toBeLessThanOrEqual(u.t === 'hyrox_run_easy' ? 0 : 0.6);
        if (u.t === 'hyrox_run_easy') {
          const km = Number(/~(\d+(?:\.\d+)?) km/.exec(g!.d ?? '')?.[1]);
          expect(km, label).toBeCloseTo(Math.round(hyroxRunLengthKm(g!) * 10) / 10, 9);
        } else if (run < 100) quality++;
      }
    }
    expect(quality).toBeGreaterThan(0);
    const bricks = ws.filter(w => w.discipline === 'brick');
    expect(bricks.some(w => w.t === 'hyrox_sim')).toBe(true);
    for (const caps of [[100, 100, 95], [95, 100, 100], [100, 50, 100]] as Caps[]) expect(applyHyroxInjuryGates(bricks, injOf(caps), 0, access)).toEqual([]);
    expect(applyHyroxInjuryGates(bricks, injOf([100, 100, 100]), 0, access).length).toBe(bricks.length);
    const ergs = [0, 1].map(slotIndex => generateHyroxEasyErg({ targetMinutes: 40, stationAccess: access, slotIndex })!);
    expect(ergs.map(e => (e.d ?? '').includes('easy on the SkiErg.'))).toEqual([true, false]);
    for (const e of ergs) {
      const ski = (e.d ?? '').includes('easy on the SkiErg.');
      for (const [up, lo] of [[50, 100], [100, 50], [0, 100], [30, 30]]) {
        const [g] = applyHyroxInjuryGates([e], injOf([100, up, lo]), 0, access);
        const cap = ski ? up : Math.min(up, lo);
        if (cap <= 0) { expect(g).toBeUndefined(); continue; }
        const min = cap >= 100 ? e.estimatedDurationMin : Math.max(1, Math.round((e.estimatedDurationMin ?? 0) * cap / 100));
        expect(g!.estimatedDurationMin).toBe(min);
        expect(g!.d).toMatch(new RegExp(`^${min} min easy on the `));
      }
    }
    const assess = prescribed(s.wks[0]).find(w => w.t === 'hyrox_assessment')!;
    const all = assess.hyroxComponents ?? [];
    let partialPass = 0;
    for (const caps of [[100, 100, 0], [100, 0, 100], [100, 100, 50], [100, 50, 100], [100, 80, 40], [100, 95, 100], [0, 100, 100], [100, 100, 100]] as Caps[]) {
      const [, up, lo] = caps;
      const [g] = applyHyroxInjuryGates([assess], injOf(caps), 0, access);
      const keep = all.filter(c => capOfStation(c.type as HyroxStation, up, lo) >= 100);
      const label = `assessment at ${caps.join('/')}`;
      // None with a side at 0 (its full-body stations load both sides).
      if (keep.length === 0 || Math.min(up, lo) <= 0) { expect(g, label).toBeUndefined(); continue; }
      expect(g, label).toBeDefined();
      if (keep.length === all.length) { expect(g, label).toBe(assess); continue; }
      partialPass++;
      // Each station kept whole (its calibration pass), the rest left out
      // and named; minutes and MTL from the stations kept.
      expect(g!.hyroxComponents, label).toEqual(keep);
      expect(g!.estimatedDurationMin, label).toBe(Math.round(keep.reduce((a, c) => a + (c.durationSec ?? 0) / 60, 0) + keep.length * 2));
      expect(g!.musculoTendonLoad ?? 0, label).toBeCloseTo(keep.reduce((a, c) => a + c.mtl, 0), 9);
      expect(g!.d ?? '', label).toContain(`Easy walkthrough of ${keep.length} of the ${all.length} stations`);
      expect(g!.d ?? '', label).toContain('left out (injury): a time at reduced volume is not a benchmark.');
    }
    expect(partialPass).toBeGreaterThan(2);
  }, 120000);

  it('a standalone strength session takes the shared strength decision: paused, or the region-safe session at the decision\'s own length (each region\'s block at its capacity, the core block whole), never above the uninjured minutes, at the lower of the two RPEs so its planned TSS follows its minutes; in the decision\'s resolved phase the lower capacity\'s share of its minutes and reps, as a station session\'s block; never longer or above its planned TSS, and as a side\'s capacity rises a kept session stays and its minutes and planned TSS never fall: every band at the lowest and the default hours, four phases, five locations (v2 review: it kept the uninjured minutes whatever the capacities, 45 min at upper and lower body 5 where the decision prescribes 12)', () => {
    const seen = new Set<string>();
    const sessions: Array<{ label: string; u: Workout }> = [];
    for (const band of BANDS) {
      for (const h of [HYROX_HOURS_RANGE[band].min, HYROX_HOURS_RANGE[band].default].filter((x, i, a) => a.indexOf(x) === i)) {
        const s = build(band, h, 16, V_SINGLES[1]);
        for (const wk of s.wks) for (const u of prescribed(wk).filter(isHyroxStrengthSession)) {
          const k = JSON.stringify([u.d, u.estimatedDurationMin, u.rpe]);
          if (!seen.has(k)) { seen.add(k); sessions.push({ label: `${band} ${h}h W${wk.w}`, u }); }
        }
      }
    }
    const steps = [0, 5, 10, 25, 50, 75, 95, 100];
    const pairs: Array<[number, number]> = [];
    for (const a of steps) for (const b of steps) pairs.push([a, b]);
    let adapted = 0; let paused = 0; let resolved = 0; let shorter = 0; let steppedUp = 0;
    const off: string[] = [];
    for (const { label, u } of sessions) {
      const uMin = u.estimatedDurationMin ?? 0;
      const uTss = hyroxSessionPlannedTss(u);
      for (const phase of ['acute', 'rehab', 'graduated_return', 'resolved']) {
        for (const location of ['other', 'knee', 'shoulder', 'back', 'wrist']) {
          const inj = (up: number, lo: number) => ({ ...injOf([100, up, lo], location), injuryPhase: phase } as unknown as InjuryState);
          const gate = (up: number, lo: number) => applyHyroxInjuryGates([u], inj(up, lo))[0];
          for (const [up, lo] of pairs) {
            const g = gate(up, lo);
            const l = `${label} ${u.n} ${phase} ${location} at ${up}/${lo}`;
            const dec = injuryStrengthDecision(inj(up, lo));
            if (dec.kind === 'none') { paused++; if (g) off.push(`${l}: kept under a paused decision`); continue; }
            if (dec.kind === 'adapted') {
              adapted++;
              if (!g) { off.push(`${l}: left out under an adapted decision`); continue; }
              const want = Math.min(dec.workout.estimatedDurationMin ?? 0, uMin);
              if (g.estimatedDurationMin !== want) off.push(`${l}: ${g.estimatedDurationMin} min, the decision's ${dec.workout.estimatedDurationMin} capped at ${uMin}`);
              if (want < uMin) shorter++;
              const rpe = Math.min(dec.workout.rpe ?? 0, u.rpe ?? 0);
              if (g.rpe !== rpe || g.r !== rpe) off.push(`${l}: RPE ${g.rpe}, the lower of ${dec.workout.rpe} and ${u.rpe} is ${rpe}`);
              if (g.d !== dec.workout.d || g.id !== u.id || g.dayOfWeek !== u.dayOfWeek) off.push(`${l}: not the decision's session on its slot`);
              if (Math.abs(hyroxSessionPlannedTss(g) - want * plannedTssPerMin('gym', rpe)) > 1e-9) off.push(`${l}: planned TSS off its minutes`);
            } else {
              resolved++;
              const share = Math.min(up, lo) / 100;
              if (share >= 1) { if (g !== u) off.push(`${l}: changed at full capacity`); continue; }
              if (g && g.estimatedDurationMin !== Math.floor(uMin * share + 1e-9)) off.push(`${l}: ${g.estimatedDurationMin} min, not the lower capacity's share of ${uMin}`);
              if (g) for (const line of (g.d ?? '').split('\n')) {
                const m = /^(\d+)x(\d+)/.exec(line);
                const was = m && (u.d ?? '').split('\n').find(x => x.slice(/^(\d+)x(\d+)/.exec(x)?.[0].length ?? 0) === line.slice(m[0].length));
                if (m && was && Number(m[2]) > Math.floor(Number(/^(\d+)x(\d+)/.exec(was)![2]) * share + 1e-9)) off.push(`${l}: ${line} above its share`);
              }
            }
            if (!g) continue;
            if ((g.estimatedDurationMin ?? 0) > uMin) off.push(`${l}: longer than the uninjured session`);
            if (hyroxSessionPlannedTss(g) > uTss + 1e-9) off.push(`${l}: planned TSS above the uninjured session's`);
            if ((g.estimatedDurationMin ?? 0) > 0 && hyroxSessionPlannedTss(g) > (uTss * (g.estimatedDurationMin ?? 0)) / uMin + 1e-9) off.push(`${l}: planned TSS above the uninjured rate at its minutes`);
            if ((g.musculoTendonLoad ?? 0) > (u.musculoTendonLoad ?? 0) + 1e-9) off.push(`${l}: MTL above the uninjured session's`);
            for (const [nu, nl] of [[Math.min(100, up + 5), lo], [up, Math.min(100, lo + 5)]] as Array<[number, number]>) {
              if (nu === up && nl === lo) continue;
              const h2 = gate(nu, nl);
              steppedUp++;
              if (!h2) { off.push(`${l} to ${nu}/${nl}: kept, then left out`); continue; }
              if ((h2.estimatedDurationMin ?? 0) < (g.estimatedDurationMin ?? 0) || hyroxSessionPlannedTss(h2) < hyroxSessionPlannedTss(g) - 1e-9) off.push(`${l} to ${nu}/${nl}: minutes or planned TSS fell`);
            }
          }
        }
      }
    }
    expect(sessions.length).toBeGreaterThan(10);
    expect(adapted).toBeGreaterThan(5000);
    expect(paused).toBeGreaterThan(100);
    expect(resolved).toBeGreaterThan(1000);
    expect(shorter).toBeGreaterThan(1000);
    expect(steppedUp).toBeGreaterThan(5000);
    expect(off.slice(0, 10)).toEqual([]);
  }, 300000);
});

describe('a plan rebuilt under an injury is the plan without it through the injury gates', () => {
  /** The plan rebuilt from week `from` under [run, upper, lower] capacities. */
  const rebuilt = (base: SimulatorState, caps: Caps, from: number): Week[] => {
    const inj = structuredClone(base);
    inj.w = from;
    (inj as unknown as { injuryState: unknown }).injuryState = injOf(caps);
    const regen = regenerateHyroxWeeksFrom(inj, from);
    return inj.wks.map((wk, k) => (k >= from - 1 ? regen[k - (from - 1)] ?? wk : wk));
  };
  const strip = (ws: readonly Workout[]) => JSON.stringify(ws.map(w => (w.hyroxSpec?.loadSteps ? { ...w, hyroxSpec: { ...w.hyroxSpec, loadSteps: undefined } } : w)));
  const hasWork = (wk: Week | undefined) => prescribed(wk).some(w => (w.discipline === 'station' || w.discipline === 'brick') && !isHyroxEasyErg(w));
  /** A week's station work by side (week 1's assessment, a calibration pass
   *  the gates scale by length, its sets as planned, left out). */
  const workOf = (wk: Week | undefined) => {
    const ws = prescribed(wk).filter(w => (w.discipline === 'station' || w.discipline === 'brick') && w.t !== 'hyrox_assessment');
    return { upper: ws.reduce((a, w) => a + sideSecOf(w, 'upper'), 0), lower: ws.reduce((a, w) => a + sideSecOf(w, 'lower'), 0), full: ws.reduce((a, w) => a + fullSecOf(w), 0) };
  };
  const runMin = (wk: Week | undefined) => prescribed(wk).filter(w => w.discipline === 'run').reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
  const minutes = (wk: Week | undefined) => prescribed(wk).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
  const tssOf = (wk: Week | undefined) => prescribed(wk).reduce((a, w) => a + hyroxSessionPlannedTss(w), 0);
  const mtlOf = (wk: Week | undefined) => (wk?.triWorkouts ?? []).reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);

  it('each current and future week holds the uninjured week\'s sessions through the gates on their days (none added or moved), each side\'s and the full-body station work and the running within their shares, no more minutes, planned TSS or MTL than the uninjured week and never over the weekly MTL cap the uninjured week holds (so its deload ceiling, taper fractions and acute:chronic guard hold), the weeks before untouched, and the hard rules (no hard sessions on consecutive days and 48 h between eccentric sessions, Sunday to Monday included; no single run above 110% of the 4-week longest; no brick under a restriction): every band at the lowest and the default hours, 12 weeks, rebuilt from week 1 and from week 8, five variants, run-only, one-sided, equal and unequal injuries', () => {
    const variants = [V_SINGLES, V_DOUBLES, V_PRO_DOUBLES, V_ROW, V_NOERG];
    const states: Caps[] = [[0, 100, 100], [50, 100, 100], [100, 30, 100], [100, 100, 50], [50, 50, 50], [100, 30, 50], [0, 100, 50], [100, 90, 95]];
    let plans = 0; let weeks = 0; let sessions = 0; let left = 0;
    const off: string[] = [];
    for (const [name, over] of variants) {
      for (const band of BANDS) {
        for (const hrs of [HYROX_HOURS_RANGE[band].min, HYROX_HOURS_RANGE[band].default].filter((x, i, a) => a.indexOf(x) === i)) {
          const base = build(band, hrs, 12, over);
          const access = base.hyroxConfig!.stationAccess;
          const tw = planTrainingWeeks(base);
          const { detail } = generateHyroxPlanDetailed(structuredClone(base));
          for (const from of [1, 8]) {
            for (const caps of states) {
              const wks = rebuilt(base, caps, from);
              plans++;
              const [run, up, lo] = caps;
              const label = `${name} ${band} ${hrs}h from W${from} at ${caps.join('/')}`;
              const flat: Array<{ day: number; w: Workout; week: number }> = [];
              wks.slice(0, tw).forEach((wk, i) => { for (const w of prescribed(wk)) flat.push({ day: i * 7 + (w.dayOfWeek ?? 0), w, week: i + 1 }); });
              flat.sort((a, b) => a.day - b.day);
              for (let i = 0; i < flat.length; i++) {
                for (let j = i + 1; j < flat.length && flat[j].day - flat[i].day <= 1; j++) {
                  if (flat[j].day === flat[i].day) continue;
                  if (isHighIntensity(flat[i].w) && isHighIntensity(flat[j].w)) off.push(`${label} W${flat[i].week}: hard on consecutive days`);
                  if (isEccentricSession(flat[i].w) && isEccentricSession(flat[j].w)) off.push(`${label} W${flat[i].week}: eccentric within 48 h`);
                }
              }
              const longest = (wk: Week | undefined) => Math.max(0, ...prescribed(wk).filter(w => w.discipline === 'run').map(hyroxRunLengthKm));
              for (let i = 0; i < tw; i++) {
                const u = base.wks[i];
                const wk = wks[i];
                const l = `${label} W${i + 1}`;
                if (i + 1 < from) { if (strip(wk.triWorkouts ?? []) !== strip(u.triWorkouts ?? [])) off.push(`${l}: a week before the current one changed`); continue; }
                weeks++;
                // The derivation: the uninjured week's sessions through the gates.
                if (strip(wk.triWorkouts ?? []) !== strip(applyHyroxInjuryGates(u.triWorkouts ?? [], injOf(caps), 0, access))) off.push(`${l}: not the uninjured week through the gates`);
                const byId = new Map(prescribed(u).map(w => [w.id, w] as const));
                for (const w of prescribed(wk)) {
                  sessions++;
                  const v = byId.get(w.id);
                  if (!v || v.dayOfWeek !== w.dayOfWeek || (v.t !== w.t && !isHyroxStrengthSession(v))) off.push(`${l}: ${w.n} not on its uninjured slot`);
                }
                left += prescribed(u).length - prescribed(wk).length;
                const a = workOf(wk); const b = workOf(u);
                if (a.upper > (up / 100) * b.upper + 1e-6 || a.lower > (lo / 100) * b.lower + 1e-6 || a.full > (Math.min(up, lo) / 100) * b.full + 1e-6) off.push(`${l}: station work above a share`);
                if (runMin(wk) > runMin(u)) off.push(`${l}: more running`);
                for (const w of prescribed(wk).filter(x => x.discipline === 'run')) {
                  const v = byId.get(w.id)!;
                  if ((w.estimatedDurationMin ?? 0) > Math.max(1, Math.round(((v.estimatedDurationMin ?? 0) * run) / 100))) off.push(`${l}: ${w.n} above the run share`);
                }
                if (minutes(wk) > minutes(u) || tssOf(wk) > tssOf(u) + 1e-6) off.push(`${l}: more minutes or TSS than the uninjured week`);
                // MTL (v2 review: a jog in place of an erg warm-up put 37 to 39
                // injured weeks over the weekly MTL cap the uninjured week held).
                if (mtlOf(wk) > mtlOf(u) + 1e-6) off.push(`${l}: more MTL than the uninjured week`);
                const cap = base.hyroxConfig!.mtlCap;
                if (mtlOf(u) <= cap + 1e-6 && mtlOf(wk) > cap + 1e-6) off.push(`${l}: above the weekly MTL cap`);
                const d = detail[i];
                if (d.deloadCapMin != null && minutes(u) <= d.deloadCapMin + 1e-6 && minutes(wk) > d.deloadCapMin + 1e-6) off.push(`${l}: above the deload ceiling`);
                if (d.acwrCapTss != null && tssOf(u) - d.guardExemptTss <= d.acwrCapTss + 1e-6 && tssOf(wk) - d.guardExemptTss > d.acwrCapTss + 1e-6) off.push(`${l}: above the acute:chronic guard`);
                if ((run < 100 || Math.min(up, lo) < 100) && prescribed(wk).some(w => w.discipline === 'brick')) off.push(`${l}: a brick under a restriction`);
                if (i >= 4) {
                  const prev = Math.max(...[1, 2, 3, 4].map(k => longest(wks[i - k])));
                  if (prev > 0 && longest(wk) > 1.1 * prev + 1e-6 && !(longest(u) > 1.1 * Math.max(...[1, 2, 3, 4].map(k => longest(base.wks[i - k]))) + 1e-6)) off.push(`${l}: a run above 110% of the 4-week longest`);
                }
              }
            }
          }
        }
      }
    }
    expect(plans).toBe(5 * 2 * 8 * BANDS.reduce((a, b) => a + (HYROX_HOURS_RANGE[b].min === HYROX_HOURS_RANGE[b].default ? 1 : 2), 0));
    expect(weeks).toBeGreaterThan(4000);
    expect(sessions).toBeGreaterThan(10000);
    expect(left).toBeGreaterThan(1000);
    expect(off.slice(0, 10)).toEqual([]);
  }, 600000);

  it('as any one capacity rises the rebuilt plan loses nothing: every week keeps its sessions and holds no less station work on either side, running, minutes, planned TSS or MTL (run 0 to 50 to 100 at 50/50, a side clearing from 95 to 100 at 30, the lower body past a tie at upper body 50), singles and doubles, every band at the lowest and the default hours, 12 and 16 weeks', () => {
    const chains: Caps[][] = [[[0, 50, 50], [50, 50, 50], [100, 50, 50]], [[100, 30, 95], [100, 30, 100]], [[100, 95, 30], [100, 100, 30]], [[100, 50, 45], [100, 50, 50], [100, 50, 55]]];
    let weeks = 0; let held = 0;
    const off: string[] = [];
    for (const [name, over] of [V_SINGLES, V_DOUBLES]) {
      for (const band of BANDS) {
        for (const hrs of [HYROX_HOURS_RANGE[band].min, HYROX_HOURS_RANGE[band].default].filter((x, i, a) => a.indexOf(x) === i)) {
          for (const len of [12, 16]) {
            const base = build(band, hrs, len, over);
            const tw = planTrainingWeeks(base);
            for (const chain of chains) {
              const plans = chain.map(c => rebuilt(base, c, 1));
              for (let k = 0; k + 1 < plans.length; k++) {
                for (let i = 0; i < tw; i++) {
                  weeks++;
                  const a = plans[k][i]; const b = plans[k + 1][i];
                  const l = `${name} ${band} ${hrs}h ${len}w W${i + 1}: ${chain[k].join('/')} to ${chain[k + 1].join('/')}`;
                  if (hasWork(a)) held++;
                  const ids = new Set(prescribed(b).map(w => w.id));
                  if (prescribed(a).some(w => !ids.has(w.id))) off.push(`${l}: a session left`);
                  const wa = workOf(a); const wb = workOf(b);
                  if (wb.upper < wa.upper - 1e-6 || wb.lower < wa.lower - 1e-6 || wb.full < wa.full - 1e-6) off.push(`${l}: less station work`);
                  if (runMin(b) < runMin(a) || minutes(b) < minutes(a) || tssOf(b) < tssOf(a) - 1e-6 || mtlOf(b) < mtlOf(a) - 1e-6) off.push(`${l}: less running, minutes, TSS or MTL`);
                }
              }
            }
          }
        }
      }
    }
    expect(weeks).toBeGreaterThan(3000);
    expect(held).toBeGreaterThan(1000);
    expect(off.slice(0, 10)).toEqual([]);
  }, 600000);
});

describe('a station session\'s warm-up under an injury', () => {
  it('takes, among the ways carrying the planned way\'s MTL a minute (an erg moves only to the other erg, a jog stays a jog), the way with the highest capacity of its own (the SkiErg the upper body\'s, the Row Erg the lower of the two sides\'), ties in the decision\'s order, and keeps that capacity\'s share, equal restrictions too; never opens a session with a jog its uninjured session warmed up for on an erg (v2 review: MTL rose above the uninjured session and fell as a capacity rose); never opens a kept session with a whole SkiErg or Row Erg warm-up under an upper-body restriction; the station floor counts the planned warm-up (review round 5: open singles men under upper body 30, 157 kept sessions opened with 10 min on the SkiErg; review round 6: under the neck default every kept session opened with a whole Row Erg warm-up; review round 7: equal restrictions kept an erg whole, so a jog cut to the run share replaced it as run capacity rose and the session then left)', () => {
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
            if (want.min < HYROX_SESSION_WARMUP_MIN) {
              shared++;
              if (upper === lower && want.mode !== 'run') equalShared++;
              if (!(g.modReason ?? '').includes(` cut to ${want.min} min.`)) off.push(`${label}: no cut note`);
            }
            if (upper < 100 && upper < lower && wu && wu.mode !== 'run' && wu.min >= HYROX_SESSION_WARMUP_MIN) off.push(`${label}: a whole erg warm-up under an upper-body restriction`);
            if (wu && (wu.mode === 'run') !== (planned === 'run')) off.push(`${label}: moved between a jog and an erg`);
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

  it('reaches the rebuilt plan: under a shoulder restriction every current and future station session opens with a Row Erg warm-up at the shared capacity\'s 5 min, never a SkiErg one and never a jog, at run capacity 100 and 50 (the plan passes the athlete\'s ergs to the gates)', () => {
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
            expect(w.hyroxSpec?.warmup?.mode, label).toBe('row_erg');
            expect(w.hyroxSpec?.warmup?.min, label).toBe(Math.round(HYROX_SESSION_WARMUP_MIN * 0.5));
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
                if (Math.round(after + HYROX_SESSION_WARMUP_MIN) >= HYROX_MIN_STATION_SESSION_MIN) off.push(`${band} ${len}w ${u.n} run ${runCap}: left out with ${after.toFixed(1)} min of station work after the warm-up`);
                if (runCap === 0 && (u.hyroxRounds ?? 1) === 1) oneRoundLeft++;
                continue;
              }
              if (Math.round(after + HYROX_SESSION_WARMUP_MIN) < HYROX_MIN_STATION_SESSION_MIN) off.push(`${band} ${len}w ${u.n} run ${runCap}: kept with ${after.toFixed(1)} min of station work after the warm-up`);
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
                // Priced from the session's seconds (injury gate v2: the
                // rounded length less round 1 fell as round 1 grew).
                const dur = g.estimatedDurationMin ?? 0;
                const easy = roundOneMin(g);
                const tssWant = (hyroxSessionWorkMin(g) - easy) * plannedTssPerMin(g.t ?? '', rpe) + easy * plannedTssPerMin('', HYROX_EASY_RPE);
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
              expect(holdsStationFloor(x), `${band} ${u.n} run ${run} ${hyroxSessionWorkMin(x).toFixed(1)} min`).toBe(Math.round(after + HYROX_SESSION_WARMUP_MIN) >= HYROX_MIN_STATION_SESSION_MIN);
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
    let exempt = 0; let kept = 0; let held = 0; let oneRoundLeft = 0;
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
            // capacity 30 or 50 the jog shortens, at 0 round 1 is the
            // warm-up: a jog never moves to an erg).
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
                // It leaves only when no warm-up way is left and round 1 as
                // the warm-up would leave it one round.
                const noWay = warmRule(u.hyroxSpec!.warmup!.mode, run, 100, 100, access).min <= 0;
                expect(!!g, label).toBe(!(noWay && (u.hyroxRounds ?? 1) <= 1));
                if (g) { kept++; expect(oneRound, label).toBe(false); } else oneRoundLeft++;
              }
            }
          }
        }
      }
    }
    expect(exempt).toBeGreaterThan(20);
    expect(kept + oneRoundLeft).toBe(exempt);
    expect(kept).toBeGreaterThan(oneRoundLeft);
    expect(held).toBeGreaterThan(500);
  }, 120000);
});
