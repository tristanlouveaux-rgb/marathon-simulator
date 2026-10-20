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
 *     block, and a template session runs its content's 20 min.
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
import type { AbilityBand } from '@/types/triathlon';
import {
  HYROX_HOURS_RANGE, HYROX_WEEKLY_STRUCTURE, HYROX_STRENGTH_SESSIONS, HYROX_RUN_SHARE, HYROX_RUN_FLOOR_MIN,
  HYROX_STRENGTH_BLOCK_MIN, hyroxTier, hyroxBaseMultiplier,
} from '@/constants/hyrox-constants';
import { isHyroxDeloadWeek } from './plan_engine';
import { generateHyroxPlanDetailed } from './plan_engine.hyrox';
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
