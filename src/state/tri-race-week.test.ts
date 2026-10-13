/**
 * Triathlon and cycling race week relative to race day. Rules since the taper
 * rebuild (Tristan, 2026-10-13; tri-taper.ts composeTriRaceWeek; SCIENCE_LOG
 * "Triathlon and cycling taper rebuild"), replacing the single 30-min primer
 * ride of 2026-10-08:
 *   - race-pace openers (Friel's 90 s repeats) and, for long course, Byrn's
 *     60-min brick sit 3 to 5 days out (PRIMER_MIN_DAYS_OUT,
 *     PRIMER_MAX_DAYS_OUT);
 *   - two days out is empty (rest; Friel, Allen); the day before holds only a
 *     capped activation (ride at most 30 min, run at most 10 min; Allen, Byrn),
 *     never the week's longest session;
 *   - frequency: race week plus the race keeps at least 80% of the reference
 *     week's sessions (Mujika 2011), and every discipline keeps a session;
 *   - no long run, no solo long ride, no fasted ride; no discipline twice on
 *     one day; nothing on or after race day; never heavier than the week
 *     before; the last session at most 3 days out.
 * History (2026-10-08 review): race week held a Tuesday swim and a Saturday
 * fasted ride with the 3 days before a Wednesday race empty; a 210-plan sweep
 * found 30 of 90 Monday to Wednesday races with nothing in the 3 days before
 * race day.
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

/** A quality session: a race-pace opener or the race-week brick, a ride above
 *  endurance, a CSS or speed swim, a threshold or VO2 run. */
function isQuality(w: Workout): boolean {
  if (w.taperRole === 'opener') return true;
  if (w.taperRole === 'day_before') return false;
  if (isLongRun(w) || w.t === 'brick') return false;
  if (w.discipline === 'bike') return w.t !== 'bike_endurance';
  if (w.discipline === 'swim') return w.t === 'swim_threshold' || w.t === 'swim_speed';
  return w.t === 'threshold' || w.t === 'vo2';
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

/** Swim, bike, run and brick sessions (no commute, no gym). */
const sessions = (wk: Week | undefined) => (wk?.triWorkouts ?? []).filter(w => w.t !== 'gym' && !w.commute);

function raceWeekViolations(s: SimulatorState, race: string): string[] {
  const layout = raceWeekLayout(s.planStartDate!, race)!;
  const tw = planTrainingWeeks(s);
  const wk = s.wks[tw - 1];
  const before = s.wks[tw - 2];
  const out: string[] = [];
  const longCourse = s.triConfig?.distance !== 'sprint' && s.triConfig?.distance !== 'olympic'
    && (s.triConfig?.disciplines?.length ?? 3) > 1;
  const dOut = (w: Workout) => layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0));
  for (const w of wk.triWorkouts ?? []) {
    const daysOut = dOut(w);
    const at_ = `${DOW[w.dayOfWeek ?? 0]} ${w.n} (${daysOut} days out)`;
    if (daysOut < 1) out.push(`on or after race day: ${at_}`);
    if (isQuality(w) && (daysOut < PRIMER_MIN_DAYS_OUT || daysOut > PRIMER_MAX_DAYS_OUT)) out.push(`opener outside 3 to 5 days: ${at_}`);
    if (/fasted/i.test(w.d ?? '')) out.push(`fasted ride: ${at_}`);
    if (isLongRun(w) || w.longRide) out.push(`long session: ${at_}`);
    if (w.t === 'brick' && (!longCourse || w.estimatedDurationMin !== 60 || w.taperRole !== 'opener')) out.push(`brick: ${at_} ${w.estimatedDurationMin} min`);
    if (daysOut === 2) out.push(`session on the rest day: ${at_}`);
    if (daysOut === 1 && w.taperRole !== 'day_before' && !w.commute) out.push(`not an activation the day before: ${at_}`);
    if (w.taperRole === 'day_before') {
      if (daysOut !== 1) out.push(`activation not the day before: ${at_}`);
      const cap = w.discipline === 'bike' ? 30 : 10;
      if ((w.estimatedDurationMin ?? 0) > cap) out.push(`activation over ${cap} min: ${at_} ${w.estimatedDurationMin}`);
    }
  }
  const train = sessions(wk);
  const longestOther = Math.max(0, ...train.filter(w => w.taperRole !== 'day_before').map(w => w.estimatedDurationMin ?? 0));
  for (const w of train.filter(x => x.taperRole === 'day_before')) {
    if (longestOther > 0 && (w.estimatedDurationMin ?? 0) > longestOther) out.push(`the day before holds the longest session: ${w.n} ${w.estimatedDurationMin}`);
  }
  if (before && minutes(wk) > minutes(before)) out.push(`heavier than the week before: ${minutes(wk)} > ${minutes(before)}`);
  // The last session before race day is at most 3 days out.
  const daysOut = (wk.triWorkouts ?? []).map(dOut);
  if (daysOut.length > 0 && Math.min(...daysOut) > PRIMER_MIN_DAYS_OUT) out.push(`${Math.min(...daysOut) - 1} empty days before race day`);
  // No discipline twice on one day.
  for (let d = 0; d < 7; d++) {
    for (const disc of ['swim', 'bike', 'run']) {
      const same = (wk.triWorkouts ?? []).filter(w => w.dayOfWeek === d && (w.discipline ?? 'run') === disc && !w.commute);
      if (same.length > 1) out.push(`two ${disc} sessions on ${DOW[d]}: ${same.map(w => `${w.t} ${w.estimatedDurationMin}`).join(', ')}`);
    }
  }
  // Frequency (a Monday to Wednesday or a Sunday race; a Thursday to Saturday
  // race week is cut at race day, ISSUE-364): race week plus the race holds at
  // least 80% of the reference week's sessions, and no discipline is at zero.
  let taperStart = tw;
  while (taperStart > 1 && s.wks[taperStart - 2].ph === 'taper') taperStart--;
  const ref = [...s.wks].slice(0, taperStart - 1).reverse().find(w => w.ph !== 'taper' && (w.w ?? 0) % 4 !== 0);
  if (ref && (layout.closingWeek || layout.raceDayOfWeek === 6)) {
    const need = Math.ceil(0.8 * sessions(ref).length);
    if (train.length + 1 < need) out.push(`frequency ${train.length} + race < ${need} (80% of ${sessions(ref).length})`);
    for (const disc of s.triConfig?.disciplines ?? ['swim', 'bike', 'run']) {
      const has = train.some(w => (w.discipline ?? 'run') === disc || (disc === 'run' && w.t === 'brick'));
      if (!has) out.push(`no ${disc} in race week`);
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
  it('race week: aerobic sessions early, openers 5 and 4 days out, Byrn\'s brick 3 days out', () => {
    at('2026-10-08T12:00:00');
    const s = build('70.3', '2026-11-18');
    expect(s.tw).toBe(7);
    const raceWeek = s.wks[5].triWorkouts ?? [];
    expect(raceWeek.map(w => `${DOW[w.dayOfWeek!]} ${w.t}${w.taperRole ? ` ${w.taperRole}` : ''}`)).toEqual([
      'Mon bike_endurance',
      'Mon easy',
      'Tue easy',
      'Fri easy opener',
      'Sat swim_endurance opener',
      'Sun brick opener',
    ]);
    expect(raceWeekViolations(s, '2026-11-18')).toEqual([]);
    // The last session before the race is the 60-min race-week brick with
    // 2 x 90 s builds in each leg (Byrn), 3 days out; the openers before it
    // hold as many 90 s repeats as days to go (Friel: 5, then 4).
    const last = raceWeek[raceWeek.length - 1];
    expect(last.estimatedDurationMin).toBe(60);
    expect(last.d).toContain('2×90s builds');
    expect(raceWeek[3].d).toContain('5×90s @ race pace');
    expect(raceWeek[4].d).toContain('4×90s @ race pace');
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
            // A Monday to Wednesday race week with a ride holds at least one
            // race-pace opener 3 to 5 days out (raceWeekViolations checks the
            // days), including a low budget.
            const layout = raceWeekLayout(s.planStartDate!, race)!;
            const raceWeek = s.wks[planTrainingWeeks(s) - 1];
            if (layout.closingWeek && count(raceWeek, 'bike') >= 1) {
              const openers = (raceWeek.triWorkouts ?? []).filter(isQuality);
              if (openers.length < 1) found.push(`${race} ${hours}h: no opener`);
            }
          }
        }
        expect(found.slice(0, 5)).toEqual([]);
      });
    }
  }
});
