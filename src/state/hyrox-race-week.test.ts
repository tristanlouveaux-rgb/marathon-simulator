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
 *   - race-week volume within the taper (since 2026-10-12; 0.30 of the
 *     reference week's planned minutes since 2026-10-19, hyroxTaperFraction,
 *     0.55 before; the last loaded week;
 *     since 2026-10-13 always, the session floors no longer an excuse), above
 *     it and above the week before only by the primer when the primer is all
 *     race week holds (SCIENCE_LOG §CE update 4: race week holds the primer
 *     whenever it holds a run); since round 7 (2026-10-14) the smallest
 *     circuit is exempt from the fraction, and race week may sit above the
 *     week before by the primer and that circuit when they are all it holds;
 *   - since 2026-10-13 (review of generator v18): race week keeps the peak
 *     structure minus the brick (the primer, the easy runs and the circuit),
 *     whatever a reference week thinned by the guard or the running share
 *     held, as far as 0.55 of the reference week allows (round 2: the easy
 *     runs leave first, noted on the week); the primer is fixed at HYROX_RACE_WEEK_PRIMER_MIN (10 min of
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
import { hyroxTaperFraction } from '@/constants/hyrox-constants';
import { MIN_CIRCUIT_ROUNDS, MIN_CIRCUIT_STATIONS } from '@/workouts/hyrox-generators';
import { isHyroxDeloadWeek } from '@/workouts/plan_engine';
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

/** Previous open-singles finish time that bands an athlete on the planning
 *  field (hyroxPlanningBandFor: the pooled Open Singles field here, thresholds
 *  3774, 4869, 6318 and 7853 s, S8-S9); a first-timer without running data is
 *  total_beginner (generator v18). Beginner is that band's median finish (8662
 *  s, HYROX_S89_BAND_SEEDS): the old 7800 s bands novice on the planning field. */
const BAND_PREV_SEC: Record<AbilityBand, number | null> = {
  total_beginner: null, beginner: 8662, novice: 6600, intermediate: 5400, advanced: 4200, competitive: 3300,
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
/** Planned minutes without commute runs (the plan engine's taper measure). */
const prescribedMinutes = (wk: Week | undefined) =>
  (wk?.triWorkouts ?? []).filter(w => w.commute !== true).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
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
  // loaded week: not a taper or deload week; hyroxTaperFraction, 0.30 for
  // race week after a taper week, 0.55 when race week is the whole taper), above it only by the fixed primer when the primer is all race week
  // holds (review 2026-10-13: before, the session floors could hold race week
  // at up to 0.93 of the reference week). Never above the week before, the
  // primer alone excepted. Commute runs are the athlete's travel, on top.
  let taperStart = tw;
  while (taperStart > 1 && s.wks[taperStart - 2].ph === 'taper') taperStart--;
  let refMin = (s.hyroxConfig?.weeklyHoursAvailable ?? 0) * 60;
  const phases = s.wks.slice(0, tw).map(w => w.ph);
  // The reference week skips a race-simulation week while an earlier loaded
  // week exists (lane H2b part 2).
  let firstRef = -1;
  for (let i = taperStart - 2; i >= 0; i--) {
    if (s.wks[i].ph === 'taper' || isHyroxDeloadWeek(i + 1, phases)) continue;
    if (firstRef < 0) firstRef = i;
    if (!(s.wks[i].triWorkouts ?? []).some(w => w.t === 'hyrox_sim')) { firstRef = i; break; }
  }
  if (firstRef >= 0) refMin = prescribedMinutes(s.wks[firstRef]);
  const budget = hyroxTaperFraction(tw - taperStart + 1, tw - taperStart + 1) * refMin;
  const before = tw > 1 ? prescribedMinutes(s.wks[tw - 2]) : Infinity;
  // Round 7 (2026-10-14): the smallest circuit (MIN_CIRCUIT_ROUNDS rounds of
  // MIN_CIRCUIT_STATIONS stations) is exempt from the fraction, and race week
  // may sit above the week before by the primer and that circuit when they
  // are all it holds (2-h plans lost the circuit to the fraction).
  const smallest = (wk.triWorkouts ?? []).filter(w => isStation(w) && (w.hyroxRounds ?? 0) <= MIN_CIRCUIT_ROUNDS
    && (w.hyroxComponents ?? []).filter(c => c.type !== 'run').length <= MIN_CIRCUIT_STATIONS)
    .reduce((m, w) => Math.min(m, w.estimatedDurationMin ?? 0), Infinity);
  const exempt = Number.isFinite(smallest) ? smallest : 0;
  // A primer that gave race week's one day 3 or more days out to the circuit
  // (a Thursday race, 2026-10-14): the easy run holding its run slot counts
  // in its place.
  const standInMin = (wk.hyroxPlanNotes ?? []).some(n => n.endsWith("holds the primer's run slot"))
    ? Math.max(0, ...(wk.triWorkouts ?? []).filter(w => w.t === 'hyrox_run_easy').map(w => w.estimatedDurationMin ?? 0))
    : 0;
  const primerMin = hard.reduce((m, w) => m + (w.estimatedDurationMin ?? 0), 0) + standInMin;
  const ceilingBefore = Math.max(before, HYROX_RACE_WEEK_PRIMER_MIN, exempt > 0 ? primerMin + exempt : 0);
  if (prescribedMinutes(wk) - exempt > Math.max(budget, HYROX_RACE_WEEK_PRIMER_MIN) + 1e-6) out.push(`race week ${prescribedMinutes(wk)} min (${exempt} exempt) above the ${Math.round(budget)}-min budget`);
  if (prescribedMinutes(wk) > ceilingBefore + 1e-6) out.push(`race week ${prescribedMinutes(wk)} min above the week before (${before})`);
  // No taper or race week loses all its station work (round 7 decision 4),
  // race dates included (2026-10-14: every Thursday race week held none, its
  // one day 3 or more days out the primer's; a Thursday race's taper week 1
  // lost its only mini brick to the race window). With the ergs, race week
  // can hold a circuit; the week before holds station or brick work too.
  const hasErgs = !!(s.hyroxConfig?.stationAccess.skiErg || s.hyroxConfig?.stationAccess.rowErg);
  const work = (w: Workout) => isStation(w) || w.t === 'hyrox_brick' || w.t === 'hyrox_mini_brick';
  if (hasErgs && !(wk.triWorkouts ?? []).some(work)) out.push('race week holds no station work');
  if (tw > 1 && s.wks[tw - 2].ph === 'taper' && !(s.wks[tw - 2].triWorkouts ?? []).some(work)) out.push('taper week 1 holds no station or brick work');
  return out;
}

describe('scenario hyrox: Saturday race in week 12', () => {
  // Generator v18 (2026-10-12): intermediate tier (1:30:00 open singles), one
  // station session a week, a 2-week taper at 0.70 / 0.55 of the reference
  // week. Race week keeps the peak structure minus the brick: the tempo primer,
  // easy runs on the latest free days and the station session as a light
  // circuit (review 2026-10-13: the v18 draft copied a reference week's two
  // runs). Round 4 (2026-10-13): race week holds no more runs than the
  // reference week (week 10: the long run and the 8 x 1 km, D6), so one easy
  // run; the rest of its 0.55 is easy erg work 3 or more days out (D1), no
  // longer than the taper long run of week 11.
  it('race week is the tempo primer, a light circuit, easy erg work and an easy run the day before', () => {
    at('2026-10-08T12:00:00');
    const s = build({ customRaceDate: '2026-12-26' });
    expect(s.tw).toBe(12);
    const race = s.wks[11].triWorkouts ?? [];
    // Since 2026-10-19 race week holds 0.30 of the reference week (0.55
    // before): the easy erg session the 0.55 left room for is gone.
    expect(race.map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Tue hyrox_run_tempo',
      'Wed hyrox_station_technique',
      'Fri hyrox_run_easy',
    ]);
    expect(race.filter(w => w.discipline === 'run').length).toBeLessThanOrEqual(
      (s.wks[9].triWorkouts ?? []).filter(w => w.discipline === 'run').length);
    // The primer: 10 min of tempo work in a 25-min session.
    const primer = race.find(w => w.t === 'hyrox_run_tempo')!;
    expect(primer.estimatedDurationMin).toBe(HYROX_RACE_WEEK_PRIMER_MIN);
    expect(primer.d).toMatch(/ 10 min at /);
    expect(raceWeekViolations(s, '2026-12-26')).toEqual([]);
    // The light circuit keeps the ergs and the farmer carry.
    for (const w of race.filter(w => isStation(w) && w.t !== 'hyrox_erg_easy')) {
      expect((w.hyroxComponents ?? []).map(c => c.type).sort()).toEqual(['farmer_carry', 'row_erg', 'ski_erg']);
    }
    // The run the day before the race is an easy jog of 20 min or less.
    expect(race.find(w => w.dayOfWeek === 4)!.estimatedDurationMin).toBeLessThanOrEqual(20);
    // Race-week volume: within 0.30 of the reference week (week 10, peak)
    // beside the exempt primer and smallest circuit (raceWeekViolations).
    expect(minutes(s.wks[11])).toBeLessThan(minutes(s.wks[10]));
    // The week before keeps its Mini Brick (8 days out) and its long run (7 days out).
    expect((s.wks[10].triWorkouts ?? []).some(w => w.t === 'hyrox_mini_brick' && w.dayOfWeek === 4)).toBe(true);
    expect((s.wks[10].triWorkouts ?? []).find(w => w.n === 'Long Run')?.dayOfWeek).toBe(5);
  });

  it('without ergs the race week has no station circuit; the circuit slots are left out', () => {
    at('2026-10-08T12:00:00');
    const s = build({ customRaceDate: '2026-12-26', hyroxHasSkiErg: false, hyroxHasRowErg: false } as Partial<OnboardingState>);
    const race = s.wks[11].triWorkouts ?? [];
    // Before (2026-10-08): Mon easy, Tue tempo, Wed easy, Thu easy, Fri easy
    // (the two circuit slots as easy runs), 5 runs on 5 days in a row. Since
    // round 4 (D6) race week holds no more runs than the reference week, and
    // without erg access the rest stays unprescribed (noted). Round 5
    // (decision B, the hours ladder): without ergs the 8-h build of the peak
    // weeks holds the 8 x 1 km and 4 sessions, fewer minutes than the 7-h
    // build's two easy runs, so weeks 9 and 10 are held to the 7-h weeks
    // (the long run and two easy runs) and race week holds the primer and two
    // easy runs, no circuit.
    const ref = s.wks[9].triWorkouts ?? [];
    expect(race.filter(w => w.discipline === 'run').length).toBeLessThanOrEqual(ref.filter(w => w.discipline === 'run').length);
    expect(race.some(isStation)).toBe(false);
    expect(race.find(w => w.t === 'hyrox_run_tempo')?.dayOfWeek).toBe(1);
    expect(race.filter(w => w.t !== 'hyrox_run_tempo').every(w => w.t === 'hyrox_run_easy')).toBe(true);
    expect(minutes(s.wks[11])).toBeLessThanOrEqual(minutes(s.wks[10]));
    expect(raceWeekViolations(s, '2026-12-26')).toEqual([]);
  });
});

describe('a Monday to Wednesday race: the primer 3 days out, the last session at most 3 days out', () => {
  it('beginner, 5 h, Wednesday race 18 November: a circuit, then the Sunday primer', () => {
    at('2026-10-04T12:00:00');
    const s = build({ customRaceDate: '2026-11-18', experienceLevel: 'beginner', triTimeAvailableHoursPerWeek: 5, ...bandOnboarding('beginner') });
    const tw = planTrainingWeeks(s);
    // Before: Mon easy, Tue circuit, Wed circuit, Fri tempo (5 days out); Sat
    // to Tue empty. Running's Wednesday race holds a Sunday primer. Race week
    // holds 0.55 of the reference week (review 2026-10-13). Since round 4 the
    // reference week funds its running against the chosen hours (D2: 179 min,
    // 114 before), so the circuit, the Saturday easy run and the primer all
    // fit in its 0.55.
    // Since 2026-10-19 race week holds 0.30 of the reference week (0.55
    // before); since part 2 (2026-10-20) the reference week holds its
    // strength block, warm-up and finisher, so 0.30 of it again holds the
    // Saturday easy run beside the exempt circuit and primer.
    expect((s.wks[tw - 1].triWorkouts ?? []).map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Wed hyrox_station_technique',
      'Sat hyrox_run_easy',
      'Sun hyrox_run_tempo',
    ]);
    expect(s.wks[tw].raceClosing).toBe(true);
    expect(raceWeekViolations(s, '2026-11-18')).toEqual([]);
  });
});

describe('a Thursday race: race week keeps its station work', () => {
  it('intermediate, 8 h, Thursday race 17 December: the circuit takes Monday, 3 days out, and the primer gives it the day', () => {
    at('2026-10-05T12:00:00');
    const s = build({ customRaceDate: '2026-12-17' });
    const tw = planTrainingWeeks(s);
    // Race week runs Monday to Wednesday (3, 2 and 1 days out): its one day 3
    // or more days out was the primer's and the circuit's only day, and race
    // week held the primer and an easy run, no station work (2026-10-14).
    const rw = s.wks[tw - 1];
    // Since part 2 (2026-10-20) the fuller reference week leaves race week
    // room for a second easy run.
    expect((rw.triWorkouts ?? []).map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Mon hyrox_station_technique',
      'Tue hyrox_run_easy',
      'Wed hyrox_run_easy',
    ]);
    expect((rw.hyroxPlanNotes ?? []).some(n => /Tempo Run left out \(its day, race week's one day 3 or more days out, holds the Station Circuit: race week keeps its station work\)/.test(n))).toBe(true);
    expect(raceWeekViolations(s, '2026-12-17')).toEqual([]);
  });

  it('a race week whose only run was the primer keeps an easy run at the run floor', () => {
    at('2026-10-05T12:00:00');
    const s = build({ customRaceDate: '2026-12-17', experienceLevel: 'beginner', triTimeAvailableHoursPerWeek: 2, previousHyroxTimeSec: undefined, hyroxPreviousTimeFormat: undefined });
    const tw = planTrainingWeeks(s);
    const rw = s.wks[tw - 1].triWorkouts ?? [];
    expect(rw.some(isStation)).toBe(true);
    expect(rw.filter(w => w.t === 'hyrox_run_easy').map(w => w.estimatedDurationMin)).toEqual([20]);
    expect((s.wks[tw - 1].hyroxPlanNotes ?? []).some(n => n.endsWith("holds the primer's run slot"))).toBe(true);
    expect(raceWeekViolations(s, '2026-12-17')).toEqual([]);
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
    }, 120000);
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
