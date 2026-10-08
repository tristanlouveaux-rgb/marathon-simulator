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
 *   - race-week volume within the existing taper multiplier (0.30 of the
 *     weekly hours) unless the existing session floors hold it above, and then
 *     never above the week before.
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
import { RACE_WEEK_EXCLUDED_STATIONS, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
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

function build(over: Partial<OnboardingState>): SimulatorState {
  resetState();
  initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, ...over,
  } as OnboardingState);
  return getState();
}

const minutes = (wk: Week | undefined) =>
  (wk?.triWorkouts ?? []).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
const isStation = (w: Workout) => w.t.startsWith('hyrox_station_') || w.t === 'hyrox_assessment';
const isEasyRun = (w: Workout) => w.t === 'hyrox_run_easy' || (w.t === 'easy' && w.commute === true);

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
  const days = (wk.triWorkouts ?? []).map(w => w.dayOfWeek);
  if (new Set(days).size !== days.length) out.push('two sessions on one day');
  // Race-week volume: the existing taper multiplier (0.30 of the weekly hours,
  // plan_engine.hyrox phaseMultiplier). Where the existing session floors
  // (20-min runs, 35-min and 2-round circuits) hold a low-hours week above it,
  // never above the week before either.
  const budget = (s.hyroxConfig?.weeklyHoursAvailable ?? 0) * 0.30 * 60;
  const before = tw > 1 ? minutes(s.wks[tw - 2]) : Infinity;
  if (minutes(wk) > Math.max(budget, before)) out.push(`race week ${minutes(wk)} min above the ${budget}-min budget and the week before (${before})`);
  return out;
}

describe('scenario hyrox: Saturday race in week 12', () => {
  it('race week is the tempo primer, two light circuits and two easy runs', () => {
    at('2026-10-08T12:00:00');
    const s = build({ customRaceDate: '2026-12-26' });
    expect(s.tw).toBe(12);
    const race = s.wks[11].triWorkouts ?? [];
    expect(race.map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Mon hyrox_station_technique',
      'Tue hyrox_run_tempo',
      'Wed hyrox_station_technique',
      'Thu hyrox_run_easy',
      'Fri hyrox_run_easy',
    ]);
    expect(raceWeekViolations(s, '2026-12-26')).toEqual([]);
    // The light circuits keep the ergs and the farmer carry.
    for (const w of race.filter(isStation)) {
      expect((w.hyroxComponents ?? []).map(c => c.type).sort()).toEqual(['farmer_carry', 'row_erg', 'ski_erg']);
    }
    // Race-week volume within the existing taper multiplier (0.30 x 8 h).
    expect(minutes(s.wks[11])).toBeLessThanOrEqual(0.30 * 8 * 60);
    // The week before is unchanged: its Mini Brick stays (8 days out).
    expect((s.wks[10].triWorkouts ?? []).some(w => w.t === 'hyrox_mini_brick')).toBe(true);
  });

  it('without ergs the race week has no station circuit; the slots are easy runs', () => {
    at('2026-10-08T12:00:00');
    const s = build({ customRaceDate: '2026-12-26', hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>);
    const race = s.wks[11].triWorkouts ?? [];
    expect(race.some(isStation)).toBe(false);
    expect(race.filter(w => w.t === 'hyrox_run_tempo')).toHaveLength(1);
    expect(raceWeekViolations(s, '2026-12-26')).toEqual([]);
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
