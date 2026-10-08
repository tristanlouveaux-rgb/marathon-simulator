/**
 * Triathlon and cycling race week relative to race day (visual QA,
 * 2026-10-08): the running race-day rules (SCIENCE_LOG §CE race-week primer,
 * §CW race calendar and race-day placement) applied to the triathlon engine.
 *   - frequency: race week keeps the week before's session count per
 *     discipline (Bosquet et al. 2007, §CE update), the race taking the long
 *     run; minutes stay at the 0.30 race-week budget with the 30-min floor;
 *   - one quality session, the primer (the first ride, its distance's taper
 *     flavour), 3 to 5 days out (PRIMER_MIN_DAYS_OUT, PRIMER_MAX_DAYS_OUT);
 *   - a Monday to Wednesday race's Sunday (1 to 3 days out) is a race-week day;
 *   - race-week rides take the steady endurance variant, never the "fasted
 *     endurance (optional)" one;
 *   - nothing on or after race day; never heavier than the week before.
 *   - the primer is a short ride (review 2026-10-08): the 30-min session floor
 *     on the variant whose reps follow its minutes, so it holds a few minutes
 *     of quality (sweet spot 1x8 min, tempo 1x10 min). Before, it read the
 *     week's rotation variant: 885 of 1,776 race-week primers in a review
 *     sweep were full build sets (2x20 min sweet spot, 4x8 min, 3x10 min tempo)
 *     under a 30-min label, the root cause §CE fixed for running;
 *   - it takes running's primer day (raceWeekPrimerDow), so the last session
 *     before race day is at most 3 days out. Before, a 4 or 6 h 70.3, T100 or
 *     Ironman Wednesday race held a Tuesday swim and a Saturday ride, with
 *     Sunday, Monday and Tuesday empty (54 plans in the review sweep).
 *
 * Before (scenario tri-wednesday: 70.3, Wednesday race 18 Nov 2026,
 * onboarding Thursday 8 October): race week 6 held a Tuesday swim technique and
 * a Saturday 40-min "fasted endurance (optional)" ride; Sunday, Monday, Tuesday
 * and race day were empty. A 210-plan sweep (sprint, olympic, 70.3, Ironman,
 * cycling; 4 to 15 h; every race weekday): 6 race weeks with no session, 30 of
 * 90 Monday to Wednesday races with nothing in the 3 days before race day, race
 * week a median 0.42 of its 0.30 budget.
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

import { initializeTriathlonSimulator } from './initialization.triathlon';
import { initializeCyclingSimulator } from './initialization.cycling';
import { getState, resetState } from './store';
import { raceWeekLayout, planTrainingWeeks } from '@/workouts/race-week-layout';
import { PRIMER_MIN_DAYS_OUT, PRIMER_MAX_DAYS_OUT, RACE_DAY_HARD_SPACING_DAYS } from '@/workouts/race-day-rules';
import { isLongRun } from '@/workouts/long-run';
import { describeBikeSession, type BikeSessionKind } from '@/workouts/bike';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';

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

type Mode = 'sprint' | 'olympic' | 't100' | '70.3' | 'ironman' | 'cycling';
const MODES: Mode[] = ['sprint', 'olympic', 't100', '70.3', 'ironman', 'cycling'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function build(mode: Mode, race: string, hours?: number, weekdayHours?: number): SimulatorState {
  resetState();
  const ob = {
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', experienceLevel: 'intermediate',
    customRaceDate: race, ...(hours != null ? { triTimeAvailableHoursPerWeek: hours } : {}),
    ...(weekdayHours != null ? { triWeekdayHoursPerWeek: weekdayHours } : {}),
  };
  if (mode === 'cycling') {
    initializeCyclingSimulator({ ...ob, trainingMode: 'cycling', cyclingDistance: '160km' } as OnboardingState);
  } else {
    initializeTriathlonSimulator({ ...ob, trainingMode: 'triathlon', triDistance: mode } as OnboardingState);
  }
  return getState();
}

/** A quality session: a ride above endurance, a CSS or speed swim, a threshold or VO2 run. */
function isQuality(w: Workout): boolean {
  if (isLongRun(w) || w.t === 'brick') return false;
  if (w.discipline === 'bike') return w.t !== 'bike_endurance';
  if (w.discipline === 'swim') return w.t === 'swim_threshold' || w.t === 'swim_speed';
  return w.t === 'threshold' || w.t === 'vo2';
}
/** Minutes of quality in a bike description's main set ("Main: 1×8min @ ..."). */
function mainSetMinutes(d: string): number {
  const m = /Main: (\d+)×(\d+)min/.exec(d);
  return m ? Number(m[1]) * Number(m[2]) : Infinity;
}
/** The primer the generator should seat: the 30-min floor on variant 0. */
function expectedPrimerText(s: SimulatorState, w: Workout, week: number): string {
  return describeBikeSession(w.t.replace('bike_', '') as BikeSessionKind, 30, s.triConfig?.bike?.ftp, s.triConfig?.bike?.hasPowerMeter, week, 0, 0);
}
const minutes = (wk: Week | undefined) => (wk?.triWorkouts ?? []).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
const count = (wk: Week | undefined, disc: string) => (wk?.triWorkouts ?? []).filter(w => (w.discipline ?? 'run') === disc).length;
/** Days holding the discipline, up to weekday `lastDow`. */
const daysWith = (wk: Week | undefined, disc: string, lastDow = 6) => new Set((wk?.triWorkouts ?? [])
  .filter(w => (w.discipline ?? 'run') === disc && (w.dayOfWeek ?? 0) <= lastDow).map(w => w.dayOfWeek)).size;

/** Running rule 4's spacing in the last 13 days (RACE_DAY_HARD_SPACING_DAYS):
 *  no threshold or VO2 run on the day before or after the long run, the brick
 *  or another quality run, within the week. */
function spacingViolations(s: SimulatorState, race: string): string[] {
  const layout = raceWeekLayout(s.planStartDate!, race)!;
  const out: string[] = [];
  const isQRun = (w: Workout) => (w.discipline ?? 'run') === 'run' && (w.t === 'threshold' || w.t === 'vo2');
  const isHardRun = (w: Workout) => isQRun(w) || isLongRun(w) || w.t === 'brick';
  s.wks.forEach((wk, i) => {
    const ws = wk.triWorkouts ?? [];
    for (const q of ws.filter(isQRun)) {
      const d = q.dayOfWeek ?? 0;
      if (layout.raceDayIndex - (i * 7 + d) > RACE_DAY_HARD_SPACING_DAYS) continue;
      const next = ws.filter(w => w !== q && isHardRun(w) && Math.abs((w.dayOfWeek ?? 0) - d) === 1);
      if (next.length > 0) out.push(`week ${i + 1} ${DOW[d]} ${q.n} next to ${next.map(w => `${DOW[w.dayOfWeek ?? 0]} ${w.n}`).join(', ')}`);
    }
  });
  return out;
}

function raceWeekViolations(s: SimulatorState, race: string): string[] {
  const layout = raceWeekLayout(s.planStartDate!, race)!;
  const tw = planTrainingWeeks(s);
  const wk = s.wks[tw - 1];
  const before = s.wks[tw - 2];
  const out: string[] = [];
  const quality = (wk.triWorkouts ?? []).filter(isQuality);
  if (quality.length > 1) out.push(`${quality.length} quality sessions: ${quality.map(w => w.n).join(', ')}`);
  for (const w of wk.triWorkouts ?? []) {
    const daysOut = layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0));
    const at_ = `${DOW[w.dayOfWeek ?? 0]} ${w.n} (${daysOut} days out)`;
    if (daysOut < 1) out.push(`on or after race day: ${at_}`);
    if (isQuality(w) && (daysOut < PRIMER_MIN_DAYS_OUT || daysOut > PRIMER_MAX_DAYS_OUT)) out.push(`primer outside 3 to 5 days: ${at_}`);
    if (/fasted/i.test(w.d ?? '')) out.push(`fasted ride: ${at_}`);
    if (isLongRun(w) || w.t === 'brick') out.push(`long session: ${at_}`);
  }
  if (before && minutes(wk) > minutes(before)) out.push(`heavier than the week before: ${minutes(wk)} > ${minutes(before)}`);
  // The primer is a ride at the session floor holding a few minutes of
  // quality: at most the 10 min of the tempo variant at 30 min (sweet spot 8).
  for (const w of quality) {
    if (w.discipline !== 'bike') out.push(`primer is not a ride: ${w.n}`);
    if (w.estimatedDurationMin !== 30) out.push(`primer ${w.estimatedDurationMin} min`);
    if (mainSetMinutes(w.d ?? '') > 10) out.push(`primer main set over 10 min: ${w.d}`);
    if (w.discipline === 'bike' && w.d !== expectedPrimerText(s, w, tw)) out.push(`primer text: ${w.d}`);
  }
  // The last session before race day is at most 3 days out (the latest primer day).
  const daysOut = (wk.triWorkouts ?? []).map(w => layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0)));
  if (daysOut.length > 0 && Math.min(...daysOut) > PRIMER_MIN_DAYS_OUT) out.push(`${Math.min(...daysOut) - 1} empty days before race day`);
  // No discipline twice on one day (review 2026-10-08): two rides on one day
  // give the stimulus of one with more fatigue, so they keep no frequency.
  for (let d = 0; d < 7; d++) {
    for (const disc of ['swim', 'bike', 'run']) {
      const same = (wk.triWorkouts ?? []).filter(w => w.dayOfWeek === d && (w.discipline ?? 'run') === disc);
      if (same.length > 1) out.push(`two ${disc} sessions on ${DOW[d]}: ${same.map(w => `${w.t} ${w.estimatedDurationMin}`).join(', ')}`);
    }
  }
  // Frequency (a Monday to Wednesday or a Sunday race; a Thursday to Saturday
  // race week is still cut at race day, ISSUE-364), counted in days because a
  // double is no frequency: no fewer swim or ride days than the week before
  // held Monday to Saturday, and at most one run day fewer (the race takes the
  // long run). Race week's Sunday is the race's slot (§CT), holding at most the
  // primer of a Wednesday race.
  if (before && (layout.closingWeek || layout.raceDayOfWeek === 6)) {
    const lastDow = 5;
    for (const disc of ['swim', 'bike']) {
      if (daysWith(wk, disc) < daysWith(before, disc, lastDow)) {
        out.push(`fewer ${disc} days than the week before: ${daysWith(wk, disc)} < ${daysWith(before, disc, lastDow)}`);
      }
    }
    if (daysWith(wk, 'run') < daysWith(before, 'run', lastDow) - 1) {
      out.push(`run days ${daysWith(wk, 'run')} < ${daysWith(before, 'run', lastDow)} - 1`);
    }
  }
  return out;
}

describe('no discipline twice on one day in race week', () => {
  // Before (review sweep): 157 race-week days held two sessions of one
  // discipline, 126 of 360 cycling race weeks two rides on one day. Cycling,
  // 6 h, Sunday race: Saturday held a 49-min and a 30-min endurance ride, the
  // day before the race. Cause: race week keeps the week before's 5 rides
  // (triRaceWeekCounts), the race takes the Sunday slot, the ride days are
  // Tuesday, Thursday, Friday and Saturday, and the capacity fallback stacked
  // the fifth. A Monday race got two 30-min rides on one Tuesday (race week's
  // weekend cap is 0 when the user's weekday hours exceed race week's hours).
  // Now the fifth ride is left out.
  it('scenario: cycling, 6 h, Sunday race 22 November', () => {
    at('2026-10-04T12:00:00');
    const s = build('cycling', '2026-11-22', 6);
    const rw = s.wks[planTrainingWeeks(s) - 1].triWorkouts ?? [];
    expect(rw.filter(w => w.dayOfWeek === 5).map(w => w.t)).toEqual(['bike_endurance']);
    expect(raceWeekViolations(s, '2026-11-22')).toEqual([]);
  });

  it('weekday hours set to 0: still no double, every race weekday', () => {
    at('2026-10-04T12:00:00');
    const found: string[] = [];
    for (const mode of MODES) {
      for (const race of ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']) {
        for (const hours of [6, 10]) {
          const s = build(mode, race, hours, 0);
          const rw = s.wks[planTrainingWeeks(s) - 1].triWorkouts ?? [];
          for (let d = 0; d < 7; d++) {
            for (const disc of ['swim', 'bike', 'run']) {
              const n = rw.filter(w => w.dayOfWeek === d && (w.discipline ?? 'run') === disc).length;
              if (n > 1) found.push(`${mode} ${race} ${hours}h: ${n} ${disc} on ${DOW[d]}`);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe('the week before race week: no quality run next to the brick or the long run', () => {
  // Review 2026-10-08: for a Friday or Saturday race the race window moves the
  // brick and the long run to 8 and 7 days out; a threshold run the scheduler
  // put on Thursday then sat beside them, three hard days in a row 7 to 9 days
  // out (72 plans in a 2,160-plan sweep). Running rule 4 moves a quality run
  // that sits next to a hard day to the nearest earlier day without a run.
  it('sprint, 6 h, Saturday race 21 November: the threshold run moves from Thursday to Wednesday', () => {
    at('2026-10-04T12:00:00');
    const s = build('sprint', '2026-11-21', 6);
    const before = s.wks[planTrainingWeeks(s) - 2].triWorkouts ?? [];
    expect(before.map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Tue bike_over_under',
      'Wed swim_threshold',
      'Wed threshold',
      'Fri brick',
      'Sat long',
    ]);
    expect(spacingViolations(s, '2026-11-21')).toEqual([]);
  });
});

describe('scenario tri-wednesday: 70.3 on Wednesday 18 November', () => {
  it('race week has short sessions through the Sunday primer, 3 days out', () => {
    at('2026-10-08T12:00:00');
    const s = build('70.3', '2026-11-18');
    expect(s.tw).toBe(7);
    const raceWeek = s.wks[5].triWorkouts ?? [];
    expect(raceWeek.map(w => `${DOW[w.dayOfWeek!]} ${w.t}`)).toEqual([
      'Tue swim_endurance',
      'Wed swim_technique',
      'Wed easy',
      'Thu bike_endurance',
      'Thu easy',
      'Sat bike_endurance',
      'Sun bike_sweet_spot',
    ]);
    expect(raceWeekViolations(s, '2026-11-18')).toEqual([]);
    // The last session before the race is the primer, not a fasted ride: a
    // 30-min ride with 8 min of sweet spot, not a build session.
    const last = raceWeek[raceWeek.length - 1];
    expect(isQuality(last)).toBe(true);
    expect(last.estimatedDurationMin).toBe(30);
    expect(last.d).toBe('15min Warm up. Main: 1×8min @ Z4 threshold (≈90% FTP), 5min recovery. 5min Cool down.');
    // The closing week holds only the race.
    expect(s.wks[6].raceClosing).toBe(true);
    expect(s.wks[6].triWorkouts ?? []).toEqual([]);
  });
});

describe('every distance (T100 included), cycling, race weekday and hours budget', () => {
  // Races Monday 16 to Sunday 22 November 2026; onboarding Sunday 4 and Wednesday 14 October.
  const RACES = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  for (const now of ['2026-10-04T12:00:00', '2026-10-14T12:00:00']) {
    for (const mode of MODES) {
      it(`${mode}, onboarding ${now.slice(0, 10)}`, () => {
        at(now);
        const found: string[] = [];
        for (const race of RACES) {
          for (const hours of [4, 6, 8, 10, 12, 15]) {
            const s = build(mode, race, hours);
            for (const v of raceWeekViolations(s, race)) found.push(`${race} ${hours}h: ${v}`);
            for (const v of spacingViolations(s, race)) found.push(`${race} ${hours}h: ${v}`);
            // A Monday to Wednesday race week with a ride has its primer 3 to 5
            // days out (raceWeekViolations checks the days), including a low
            // budget whose only ride is the primer.
            const layout = raceWeekLayout(s.planStartDate!, race)!;
            const raceWeek = s.wks[planTrainingWeeks(s) - 1];
            if (layout.closingWeek && count(raceWeek, 'bike') >= 1) {
              const primer = (raceWeek.triWorkouts ?? []).filter(isQuality);
              if (primer.length !== 1) found.push(`${race} ${hours}h: no primer`);
            }
          }
        }
        expect(found.slice(0, 5)).toEqual([]);
      });
    }
  }
});
