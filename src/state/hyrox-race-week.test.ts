/**
 * HYROX race week is a taper placed relative to race day (visual QA,
 * 2026-10-08), the running race-day rules applied to HYROX (SCIENCE_LOG §CE
 * race-week primer, §CW race calendar and race-day placement, §CT the race
 * takes the long-effort slot):
 *   - no brick or mini brick: the race is the week's brick;
 *   - one hard session, the taper tempo run (the primer), 3 to 5 days out
 *     (PRIMER_MIN_DAYS_OUT, PRIMER_MAX_DAYS_OUT);
 *   - technique circuits without the eccentric-heavy or sled stations
 *     (RACE_WEEK_EXCLUDED_STATIONS), at least 3 days out;
 *   - easy runs only in the last 2 days; nothing on or after race day;
 *   - race-week volume within the taper (since 2026-10-12: taperFraction,
 *     0.55 of the reference week's planned minutes, the last loaded week)
 *     unless the session floors hold it above, and then never above the week
 *     before, except by the primer when the primer is all race week holds
 *     (SCIENCE_LOG §CE update 4: race week holds the primer whenever it holds
 *     a run);
 *   - since 2026-10-13 (review of generator v18): race week keeps the peak
 *     structure minus the brick (the primer, the easy runs and the circuit),
 *     whatever a reference week thinned by the guard or the running share
 *     held; the primer is fixed at HYROX_RACE_WEEK_PRIMER_MIN (10 min of
 *     tempo work); race week never holds more runs than the peak structure
 *     (a circuit slot never becomes a run).
 *   - review 2026-10-08: the primer takes running's primer day (Tuesday when 3
 *     to 5 days out, else the latest window day: 3 days out for every Monday
 *     to Wednesday race) and easy runs the latest free days, so the last
 *     session is at most 3 days before race day. Before, a Monday to
 *     Wednesday primer always sat 4 or 5 days out and easy runs bookended on
 *     Monday: beginner, 5 h, Wednesday race held Mon easy, Tue and Wed
 *     circuits and a Friday tempo, then 4 empty days (16 plans with 4 empty
 *     days and 40 with 3 in the review sweep);
 *   - without ergs the circuit slots are left out. Before, each became an
 *     easy run, raising race-week running above the week before's in 348 of
 *     576 no-erg plans (5 runs on 5 days in a row in the scenario).
 *
 * Before (scenario hyrox: open singles, intermediate, 8 h a week, Saturday race
 * in week 12, onboarding Thursday 8 October 2026): Mon Easy Run 20, Tue Tempo
 * Run 20, Wed Station Circuit 47 min (SkiErg, sled push, sled pull, burpee
 * broad jumps; MTL 137) 3 days out, Thu Station Circuit 48 min (row erg,
 * farmer carry, sandbag lunges, wall balls; MTL 110) 2 days out, Fri Mini
 * Brick 36 min the day before the race: 171 min against the 144-min race-week
 * budget (0.30 x 8 h, plan_engine.hyrox phaseMultiplier). Across the 252-plan
 * sweep below (before the fix) 18 race weeks were heavier than the week before.
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';

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

import { initializeHyroxSimulator } from './initialization.hyrox';
import { getMutableState, getState, resetState } from './store';
import { generateHyroxPlan } from '@/workouts/plan_engine.hyrox';
import { isHighIntensity } from '@/workouts/scheduler.hyrox';
import { raceWeekLayout, planTrainingWeeks } from '@/workouts/race-week-layout';
import { PRIMER_MIN_DAYS_OUT, PRIMER_MAX_DAYS_OUT } from '@/workouts/race-day-rules';
import { firstTrackedDow } from '@/ui/workout-status';
import {
  RACE_WEEK_EXCLUDED_STATIONS, HYROX_HOURS_RANGE, HYROX_RACE_WEEK_PRIMER_MIN, HYROX_WEEKLY_STRUCTURE, hyroxTier,
} from '@/constants/hyrox-constants';
import { taperFraction } from '@/workouts/phases';
import { isFourWeekCycleDeloadWeek } from '@/workouts/plan_engine';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';
import type { AbilityBand } from '@/types/triathlon';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorageMock.clear(); });
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

function at(localIso: string): void {
  process.env.TZ = 'Europe/London';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(localIso));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Previous open-singles finish time that bands an athlete (HYROX_TIME_TO_BAND_THRESHOLDS);
 *  a first-timer without running data is total_beginner (generator v18). */
const BAND_PREV_SEC: Record<AbilityBand, number | null> = {
  total_beginner: null, beginner: 7800, novice: 6600, intermediate: 5400, advanced: 4200, competitive: 3300,
};
function bandOnboarding(band: AbilityBand): Partial<OnboardingState> {
  const sec = BAND_PREV_SEC[band];
  return sec == null ? {} : { previousHyroxTimeSec: sec, hyroxPreviousTimeFormat: 'open_singles' } as Partial<OnboardingState>;
}

function build(over: Partial<OnboardingState>): SimulatorState {
  resetState();
  initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, ...bandOnboarding('intermediate'), ...over,
  } as OnboardingState);
  return getState();
}

const minutes = (wk: Week | undefined) =>
  (wk?.triWorkouts ?? []).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
const isStation = (w: Workout) => w.t.startsWith('hyrox_station_') || w.t === 'hyrox_assessment';
const isEasyRun = (w: Workout) => w.t === 'hyrox_run_easy' || (w.t === 'easy' && w.commute === true);
const isRun = (w: Workout) => w.t.startsWith('hyrox_run_') || w.t === 'easy';
/** Days before race day of the running engine's race-week primer, by race
 *  weekday (0 = Monday): Tuesday when 3 to 5 days out, else the latest window
 *  day (initializeSimulator probe, 2026-10-08). */
const RUNNING_PRIMER_DAYS_OUT = [3, 3, 3, 3, 3, 4, 5];

/** Every race-week rule violation of a built plan, as readable strings. */
function raceWeekViolations(s: SimulatorState, race: string): string[] {
  const layout = raceWeekLayout(s.planStartDate!, race)!;
  const tw = planTrainingWeeks(s);
  const wk = s.wks[tw - 1];
  const out: string[] = [];
  const hard: Workout[] = [];
  for (const w of wk.triWorkouts ?? []) {
    const daysOut = layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0));
    const at_ = `${DOW[w.dayOfWeek ?? 0]} ${w.n} (${daysOut} days out)`;
    if (daysOut < 1) out.push(`on or after race day: ${at_}`);
    if (w.t === 'hyrox_brick' || w.t === 'hyrox_mini_brick') out.push(`brick: ${at_}`);
    for (const c of w.hyroxComponents ?? []) {
      if ((RACE_WEEK_EXCLUDED_STATIONS as string[]).includes(c.type)) out.push(`${c.type}: ${at_}`);
    }
    if (isHighIntensity(w)) {
      hard.push(w);
      if (daysOut < PRIMER_MIN_DAYS_OUT || daysOut > PRIMER_MAX_DAYS_OUT) out.push(`primer outside 3 to 5 days: ${at_}`);
    }
    if (isStation(w) && daysOut < PRIMER_MIN_DAYS_OUT) out.push(`station in the last 2 days: ${at_}`);
    if (!isEasyRun(w) && daysOut < PRIMER_MIN_DAYS_OUT) out.push(`not an easy run in the last 2 days: ${at_}`);
  }
  if (hard.length > 1) out.push(`${hard.length} hard sessions: ${hard.map(w => w.n).join(', ')}`);
  // The primer sits where running's does when race week starts on its Monday,
  // and the last session is at most 3 days before race day.
  const firstDow = firstTrackedDow(s.planStartDate, tw, s.planCreatedAt);
  for (const w of hard) {
    const daysOut = layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0));
    if (firstDow === 0 && daysOut !== RUNNING_PRIMER_DAYS_OUT[layout.raceDayOfWeek]) {
      out.push(`primer ${daysOut} days out, running's ${RUNNING_PRIMER_DAYS_OUT[layout.raceDayOfWeek]}`);
    }
  }
  // Easy runs take the latest free days, so a race week holding one ends at
  // most 3 days before race day. A race week the taper cut to the primer
  // alone ends on the primer's day (3 to 5 days out).
  const allDaysOut = (wk.triWorkouts ?? []).map(w => layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0)));
  if (allDaysOut.length > 0 && Math.min(...allDaysOut) > PRIMER_MIN_DAYS_OUT && (wk.triWorkouts ?? []).some(isEasyRun)) {
    out.push(`${Math.min(...allDaysOut) - 1} empty days before race day`);
  }
  // A circuit slot never becomes a run (without ergs included): race week
  // holds at most the peak structure's runs (commute runs are the athlete's
  // travel, on top).
  const peakRuns = HYROX_WEEKLY_STRUCTURE[hyroxTier(s.hyroxConfig!.athleteBand)].peak.runs;
  const rwRuns = (wk.triWorkouts ?? []).filter(w => isRun(w) && w.commute !== true).length;
  if (rwRuns > peakRuns) out.push(`race week holds ${rwRuns} runs, the peak structure ${peakRuns}`);
  const days = (wk.triWorkouts ?? []).map(w => w.dayOfWeek);
  if (new Set(days).size !== days.length) out.push('two sessions on one day');
  // Race-week volume: the taper fraction of the reference week (the last
  // loaded week: not a taper or deload week; taperFraction, 0.55 for race
  // week). Where the session floors (20-min runs, 35-min and 2-round
  // circuits) hold a low-hours week above it, never above the week before.
  let taperStart = tw;
  while (taperStart > 1 && s.wks[taperStart - 2].ph === 'taper') taperStart--;
  let refMin = (s.hyroxConfig?.weeklyHoursAvailable ?? 0) * 60;
  for (let i = taperStart - 2; i >= 0; i--) {
    if (s.wks[i].ph !== 'taper' && !isFourWeekCycleDeloadWeek(i + 1, s.wks[i].ph)) { refMin = minutes(s.wks[i]); break; }
  }
  const budget = Math.round(taperFraction(tw - taperStart + 1, tw - taperStart + 1) * refMin);
  const before = tw > 1 ? minutes(s.wks[tw - 2]) : Infinity;
  const ceilingBefore = Math.max(before, HYROX_RACE_WEEK_PRIMER_MIN);
  if (minutes(wk) > Math.max(budget, ceilingBefore)) out.push(`race week ${minutes(wk)} min above the ${budget}-min budget and the week before (${before})`);
  if (minutes(wk) > ceilingBefore) out.push(`race week ${minutes(wk)} min above the week before (${before})`);
  return out;
}

describe('scenario hyrox: Saturday race in week 12', () => {
  // Generator v18 (2026-10-12): intermediate tier (1:30:00 open singles), one
  // station session a week, a 2-week taper at 0.70 / 0.55 of the reference
  // week. Race week keeps the peak structure minus the brick: the tempo primer,
  // two easy runs on the latest free days and the station session as a light
  // circuit (review 2026-10-13: the v18 draft copied a reference week's two
  // runs).
  it('race week is the tempo primer, a light circuit and easy runs on the last days', () => {
    at('2026-10-08T12:00:00');
    const s = build({ customRaceDate: '2026-12-26' });
    expect(s.tw).toBe(12);
    const race = s.wks[11].triWorkouts ?? [];
    expect(race.map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Tue hyrox_run_tempo',
      'Wed hyrox_station_technique',
      'Thu hyrox_run_easy',
      'Fri hyrox_run_easy',
    ]);
    // The primer: 10 min of tempo work in a 25-min session.
    const primer = race.find(w => w.t === 'hyrox_run_tempo')!;
    expect(primer.estimatedDurationMin).toBe(HYROX_RACE_WEEK_PRIMER_MIN);
    expect(primer.d).toMatch(/ 10 min at /);
    expect(raceWeekViolations(s, '2026-12-26')).toEqual([]);
    // The light circuit keeps the ergs and the farmer carry.
    for (const w of race.filter(isStation)) {
      expect((w.hyroxComponents ?? []).map(c => c.type).sort()).toEqual(['farmer_carry', 'row_erg', 'ski_erg']);
    }
    // The run the day before the race is an easy jog of 20 min or less.
    expect(race.find(w => w.dayOfWeek === 4)!.estimatedDurationMin).toBeLessThanOrEqual(20);
    // Race-week volume within 0.55 of the reference week (week 10, peak).
    expect(minutes(s.wks[11])).toBeLessThanOrEqual(0.55 * minutes(s.wks[9]));
    // The week before keeps its Mini Brick (8 days out) and its long run (7 days out).
    expect((s.wks[10].triWorkouts ?? []).some(w => w.t === 'hyrox_mini_brick' && w.dayOfWeek === 4)).toBe(true);
    expect((s.wks[10].triWorkouts ?? []).find(w => w.n === 'Long Run')?.dayOfWeek).toBe(5);
  });

  it('without ergs the race week has no station circuit; the circuit slots are left out', () => {
    at('2026-10-08T12:00:00');
    const s = build({ customRaceDate: '2026-12-26', hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>);
    const race = s.wks[11].triWorkouts ?? [];
    // Before (2026-10-08): Mon easy, Tue tempo, Wed easy, Thu easy, Fri easy
    // (the two circuit slots as easy runs), 5 runs on 5 days in a row.
    expect(race.map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Tue hyrox_run_tempo',
      'Thu hyrox_run_easy',
      'Fri hyrox_run_easy',
    ]);
    expect(minutes(s.wks[11])).toBeLessThanOrEqual(minutes(s.wks[10]));
    expect(raceWeekViolations(s, '2026-12-26')).toEqual([]);
  });
});

describe('a Monday to Wednesday race: the primer 3 days out, the last session at most 3 days out', () => {
  it('beginner, 5 h, Wednesday race 18 November: a circuit, an easy run, then the Sunday primer', () => {
    at('2026-10-04T12:00:00');
    const s = build({ customRaceDate: '2026-11-18', experienceLevel: 'beginner', triTimeAvailableHoursPerWeek: 5, ...bandOnboarding('beginner') });
    const tw = planTrainingWeeks(s);
    // Before: Mon easy, Tue circuit, Wed circuit, Fri tempo (5 days out); Sat
    // to Tue empty. Running's Wednesday race holds a Sunday primer.
    expect((s.wks[tw - 1].triWorkouts ?? []).map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Wed hyrox_station_technique',
      'Sat hyrox_run_easy',
      'Sun hyrox_run_tempo',
    ]);
    expect(s.wks[tw].raceClosing).toBe(true);
    expect(raceWeekViolations(s, '2026-11-18')).toEqual([]);
  });
});

describe('a plan without a race date', () => {
  it('its final week still takes the race-week content (no brick, light circuits, one hard session)', () => {
    at('2026-10-08T12:00:00');
    const s = build({ customRaceDate: null } as Partial<OnboardingState>);
    expect(s.hyroxConfig?.raceDate ?? null).toBeNull();
    const last = s.wks[s.tw - 1].triWorkouts ?? [];
    expect(last.length).toBeGreaterThan(0);
    expect(last.some(w => w.t === 'hyrox_brick' || w.t === 'hyrox_mini_brick')).toBe(false);
    expect(last.filter(isHighIntensity)).toHaveLength(1);
    for (const w of last) {
      for (const c of w.hyroxComponents ?? []) expect(RACE_WEEK_EXCLUDED_STATIONS as string[]).not.toContain(c.type);
    }
  });
});

describe('every race weekday, band, format, hours budget and station access', () => {
  // Races Monday 16 to Sunday 22 November 2026; onboarding Sunday 4 October
  // (plan starts 28 September) and Wednesday 4 November (race week 1 or 3).
  const RACES = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  const BANDS: AbilityBand[] = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'];
  for (const now of ['2026-10-04T12:00:00', '2026-11-04T12:00:00', '2026-11-12T12:00:00']) {
    it(`onboarding ${now.slice(0, 10)}`, () => {
      at(now);
      const found: string[] = [];
      let plans = 0;
      for (const race of RACES) {
        if (race <= now.slice(0, 10)) continue;
        for (const band of BANDS) {
          const hours = HYROX_HOURS_RANGE[band];
          for (const hrs of [hours.min, hours.default, hours.max]) {
            for (const fmt of ['open_singles', 'open_doubles'] as const) {
              for (const ergs of [true, false]) {
                const s = build({
                  customRaceDate: race, experienceLevel: band, triTimeAvailableHoursPerWeek: hrs, hyroxFormat: fmt,
                  hyroxHasSkiErg: ergs, hyroxHasRowErg: ergs,
                  previousHyroxTimeSec: undefined, hyroxPreviousTimeFormat: undefined, ...bandOnboarding(band),
                } as Partial<OnboardingState>);
                plans++;
                for (const v of raceWeekViolations(s, race)) found.push(`${race} ${band} ${hrs}h ${fmt} ergs=${ergs}: ${v}`);
              }
            }
          }
        }
      }
      expect(plans).toBeGreaterThan(100);
      expect(found.slice(0, 5)).toEqual([]);
    });
  }

  it('commute runs: still easy runs only in the last 2 days, one session a day', () => {
    at('2026-10-04T12:00:00');
    const found: string[] = [];
    for (const race of RACES) {
      for (const bi of [false, true]) {
        build({ customRaceDate: race });
        const s = getMutableState();
        s.commuteConfig = { enabled: true, distanceKm: 5, isBidirectional: bi, commuteDaysPerWeek: 3 };
        s.wks = generateHyroxPlan(s);
        for (const v of raceWeekViolations(s, race)) found.push(`${race} bi=${bi}: ${v}`);
      }
    }
    expect(found).toEqual([]);
  });
});
