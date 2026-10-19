/**
 * A Monday to Wednesday race forecasts exactly like the Sunday before it
 * (running parity: planTrainingWeeks, "a Tuesday race forecasts exactly like
 * the Sunday before it"). Tracking side.
 *
 * A Monday to Wednesday race's own week is a closing week that holds only the
 * race (raceClosing), so its training weeks are the Sunday-before plan's. The
 * triathlon, cycling and HYROX forecasts measured their horizon in calendar
 * days to race day, so the 1 to 3 closing-week days counted as training: an
 * Ironman on Wednesday 4 Nov 2026 (onboarding Sunday 11 Oct) forecast 44855 s
 * against 45366 s for Sunday 1 Nov, 8.5 min faster, with identical training
 * weeks. The horizon now ends with race week (raceForecastHorizonISO: the
 * Sunday before race day when the plan has a closing week), and the HYROX
 * planned-session count skips the closing week, as every running
 * weeks-of-training input reads planTrainingWeeks.
 *
 * Checked at plan creation and on the Monday of every training week (clock at
 * 12:00 on week k's Monday, s.w = k), for sprint, olympic, 70.3, Ironman,
 * cycling and HYROX, Sunday and Wednesday onboarding, Sunday races 2 to 14
 * weeks out against the Monday, Tuesday and Wednesday after.
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
import { initializeHyroxSimulator } from './initialization.hyrox';
import { getState, resetState } from './store';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { buildHyroxProjection } from '@/calculations/race-projection.hyrox';
import { predictCyclingEvent } from '@/calculations/race-prediction.cycling';
import { planTrainingWeeks, raceForecastHorizonISO } from '@/workouts/race-week-layout';
import { TRI_RACE_WEEK_SESSION_CAP_MIN } from '@/workouts/tri-taper';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Workout } from '@/types';

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

type Mode = 'sprint' | 'olympic' | '70.3' | 'ironman' | 'cycling' | 'hyrox';
const MODES: Mode[] = ['sprint', 'olympic', '70.3', 'ironman', 'cycling', 'hyrox'];

function build(mode: Mode, race: string): SimulatorState {
  resetState();
  if (mode === 'cycling') {
    initializeCyclingSimulator({
      trainingMode: 'cycling', cyclingDistance: '160km', experienceLevel: 'intermediate', customRaceDate: race,
    } as OnboardingState);
  } else if (mode === 'hyrox') {
    initializeHyroxSimulator({
      trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
      triTimeAvailableHoursPerWeek: 8, customRaceDate: race,
    } as OnboardingState);
  } else {
    initializeTriathlonSimulator({
      trainingMode: 'triathlon', triDistance: mode, experienceLevel: 'intermediate', customRaceDate: race,
    } as OnboardingState);
  }
  const s = getState();
  // The cycling forecast needs an FTP; the onboarding default may leave it unset.
  if (mode === 'cycling' && s.triConfig?.bike && !s.triConfig.bike.ftp) s.triConfig.bike.ftp = 250;
  return s;
}

/** The forecast numbers a mode shows (totals, ranges and horizon outputs). */
function forecast(mode: Mode, s: SimulatorState): unknown {
  if (mode === 'cycling') {
    const p = predictCyclingEvent(s);
    return p ? { totalSec: p.totalSec, totalRangeSec: p.totalRangeSec } : null;
  }
  if (mode === 'hyrox') {
    const p = predictHyroxRace(s);
    if (!p) return null;
    const proj = buildHyroxProjection(s, p);
    return {
      totalSec: p.totalSec, stations: p.projection, projectedTotalSec: proj.projectedTotalSec,
      confidenceRangeSec: proj.confidenceRangeSec, factors: proj.factors,
    };
  }
  const p = predictTriathlonRace(s);
  return p ? { totalSec: p.totalSec, totalRangeSec: p.totalRangeSec, projection: p.projection } : null;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Forecast at plan creation (the plan built at `now`, then `adjust`ed), then
 * on the Monday of each of the first `weeks` plan weeks (default: the plan's
 * training weeks).
 */
function forecasts(
  mode: Mode, race: string, now: string, weeks?: number, adjust?: (s: SimulatorState) => void,
): { s: SimulatorState; out: unknown[] } {
  vi.setSystemTime(new Date(now));
  const s = build(mode, race);
  adjust?.(s);
  const out: unknown[] = [forecast(mode, s)];
  const n = weeks ?? planTrainingWeeks(s);
  for (let k = 1; k <= n; k++) {
    vi.setSystemTime(new Date(`${addDays(s.planStartDate!.slice(0, 10), 7 * (k - 1))}T12:00:00`));
    s.w = k;
    out.push(forecast(mode, s));
  }
  return { s, out };
}

// Onboarding on a Sunday (plan starts Monday 5 Oct) and on a Wednesday (Monday 12 Oct).
const ONBOARDING: Array<[string, string, string]> = [
  ['Sunday', '2026-10-11T12:00:00', '2026-10-11'],
  ['Wednesday', '2026-10-14T12:00:00', '2026-10-18'],
];
const EARLY: Array<[string, number]> = [['Monday', 1], ['Tuesday', 2], ['Wednesday', 3]];

/**
 * Race week's sessions, day-free (type, name, minutes), sorted. The race-day
 * rules place race week relative to race day (HYROX: plan_engine.hyrox
 * raceWeekDays), so a Monday to Wednesday race seats the same race-week
 * sessions as the Sunday before on different days, its Sunday (R-1 to R-3)
 * included. Before the HYROX race-week rules (2026-10-08) the template kept a
 * Sunday easy run (R-1) the Sunday-before race lost to race day, and the test
 * removed it.
 */
function raceWeekSessions(s: SimulatorState): string[] {
  const wk = s.wks[planTrainingWeeks(s) - 1];
  // HYROX easy runs are listed without minutes: since 2026-10-12 the run on
  // the day before race day is at most 20 min (taper.content), and only a
  // Thursday to Sunday race has that day inside race week (a Monday to
  // Wednesday race's day before is the closing week's rest day).
  const minutes = (w: Workout) => (w.t === 'hyrox_run_easy' ? '' : String(w.estimatedDurationMin));
  return (wk.triWorkouts ?? []).map(w => `${w.t}|${w.n}|${minutes(w)}`).sort();
}

/** Race-week swim, bike and run minutes (brick legs in their discipline). */
function raceWeekMinutes(s: SimulatorState): Record<'swim' | 'bike' | 'run', number> {
  const m = { swim: 0, bike: 0, run: 0 };
  for (const w of s.wks[planTrainingWeeks(s) - 1].triWorkouts ?? []) {
    if (w.t === 'gym' || w.commute) continue;
    if (w.t === 'brick' && w.brickSegments) for (const sg of w.brickSegments) m[sg.discipline as 'swim' | 'bike' | 'run'] += sg.durationMin ?? 0;
    else m[(w.discipline ?? 'run') as 'swim' | 'bike' | 'run'] += w.estimatedDurationMin ?? 0;
  }
  return m;
}

/** Every race-week training session of a discipline (no activation, no brick)
 *  sits at its race-week cap (TRI_RACE_WEEK_SESSION_CAP_MIN): the week holds
 *  less than its fraction because it has too few days for it. */
function capLimited(s: SimulatorState, d: 'swim' | 'bike' | 'run'): boolean {
  const ws = (s.wks[planTrainingWeeks(s) - 1].triWorkouts ?? [])
    .filter(w => (w.discipline ?? 'run') === d && w.t !== 'brick' && w.t !== 'gym' && !w.commute && w.taperRole !== 'day_before');
  return ws.length > 0 && ws.every(w => (w.estimatedDurationMin ?? 0) >= TRI_RACE_WEEK_SESSION_CAP_MIN[d] - 1);
}

describe('a Monday to Wednesday race forecasts like the Sunday before it', () => {
  it('Ironman on Wednesday 4 Nov forecasts the same as Sunday 1 Nov at plan creation (was 8.5 min faster)', () => {
    at('2026-10-11T12:00:00');
    const sun = predictTriathlonRace(build('ironman', '2026-11-01'))!.totalSec;
    const wed = predictTriathlonRace(build('ironman', '2026-11-04'))!.totalSec;
    expect(sun).toBeGreaterThan(0);
    expect(wed).toBe(sun);
  });

  it('the horizon ends with race week only when the plan has a closing week', () => {
    at('2026-10-11T12:00:00');
    expect(raceForecastHorizonISO(build('ironman', '2026-11-04'), '2026-11-04')).toBe('2026-11-01');
    expect(raceForecastHorizonISO(build('ironman', '2026-11-02'), '2026-11-02')).toBe('2026-11-01');
    expect(raceForecastHorizonISO(build('ironman', '2026-11-05'), '2026-11-05')).toBe('2026-11-05');
    expect(raceForecastHorizonISO(build('ironman', '2026-11-01'), '2026-11-01')).toBe('2026-11-01');
    expect(raceForecastHorizonISO(build('hyrox', '2026-11-03'), '2026-11-03T00:00:00')).toBe('2026-11-01T00:00:00');
    // No plan weeks yet: the layout from plan start and race date decides.
    const bare = { tw: 5, planStartDate: '2026-10-05' } as SimulatorState;
    expect(raceForecastHorizonISO(bare, '2026-11-04')).toBe('2026-11-01');
    expect(raceForecastHorizonISO({ ...bare, tw: 4 } as SimulatorState, '2026-11-01')).toBe('2026-11-01');
  });

  for (const [onboardDay, now, firstSunday] of ONBOARDING) {
    for (const mode of MODES) {
      it(`${mode}, ${onboardDay} onboarding: Monday to Wednesday races forecast like the Sunday before, at plan creation and every training week`, () => {
        at(now);
        let compared = 0;
        for (let weeksOut = 2; weeksOut <= 14; weeksOut++) {
          const sunday = addDays(firstSunday, 7 * weeksOut);
          const sun = forecasts(mode, sunday, now);
          const sunWeeks = sun.s.tw;
          expect(sun.out[0], `${mode} ${sunday}`).not.toBeNull();
          for (const [day, offset] of EARLY) {
            const race = addDays(sunday, offset);
            const early = forecasts(mode, race, now, sunWeeks);
            // The same race-week volume per discipline as the Sunday before
            // (HYROX: the same sessions), on its own days. Triathlon and
            // cycling race weeks sit relative to race day (tri-taper.ts: the
            // day-before activation and the rest day exist only when those
            // days fall in race week), so their sessions differ within one
            // floor-length session per discipline. A Sunday race week whose
            // sessions of a discipline all sit at the race-week cap (a 2-week
            // Ironman plan's one-week taper) has fewer training days than a
            // Monday to Wednesday race week, which holds more of the same
            // budget.
            if (mode === 'hyrox') {
              expect(raceWeekSessions(early.s), `${mode} ${day} ${race}`).toEqual(raceWeekSessions(sun.s));
            } else {
              const a = raceWeekMinutes(early.s);
              const b = raceWeekMinutes(sun.s);
              for (const d of ['swim', 'bike', 'run'] as const) {
                const label = `${mode} ${day} ${race} ${d}: ${a[d]} vs ${b[d]}`;
                if (capLimited(sun.s, d)) expect(a[d] - b[d], label).toBeGreaterThanOrEqual(-20);
                else expect(Math.abs(a[d] - b[d]), label).toBeLessThanOrEqual(20);
              }
            }
            // Same training weeks, plus the closing week.
            expect(early.s.tw, `${mode} ${day} ${race}`).toBe(sunWeeks + 1);
            expect(early.s.wks[early.s.tw - 1].raceClosing, `${mode} ${day} ${race}`).toBe(true);
            expect(planTrainingWeeks(early.s)).toBe(sunWeeks);
            early.out.forEach((f, i) => {
              const label = `${mode} ${day} ${race}, ${i === 0 ? 'plan creation' : `week ${i}`}`;
              // The planned-dose window starts at wks[s.w] (s.w = 1 at plan
              // creation, tri-volume-by-discipline).
              const taperOnly = sun.s.wks.slice(Math.max(1, i), sunWeeks).every(w => w.ph === 'taper');
              if (mode !== 'hyrox' && taperOnly) {
                // With only taper weeks ahead the forecast reads race week's
                // planned dose, and race week's sessions sit relative to race
                // day (the Sunday race holds the day-before activation and its
                // rest day; a Monday to Wednesday race's day before falls in
                // the closing week, tri-taper.ts). Same budget, so the totals
                // stay close: at most 0.28% apart in this sweep (an Ironman
                // 2-week plan, 2.2 min), checked against 0.5%.
                const a = (f as { totalSec: number }).totalSec;
                const b = (sun.out[i] as { totalSec: number }).totalSec;
                expect(Math.abs(a - b) / b, label).toBeLessThanOrEqual(0.005);
              } else {
                expect(f, label).toEqual(sun.out[i]);
              }
              compared += 1;
            });
          }
        }
        expect(compared).toBeGreaterThan(300);
      });
    }
  }

  // In the closing week the training horizon is 0 (training is over), as on a
  // Sunday race's race day, but the race is still ahead: the HYROX race-day
  // readiness factor (recovery signals, not training) still applies.
  it('closing week: no training credited, the HYROX race-day readiness factor still applies', () => {
    at('2026-10-11T12:00:00');
    const tri = build('ironman', '2026-11-18');
    const hx = build('hyrox', '2026-11-18');
    // 28 days of poor sleep: a readiness score below neutral.
    hx.physiologyHistory = Array.from({ length: 28 }, (_, i) => ({ date: addDays('2026-10-20', i), sleepScore: 20 })) as SimulatorState['physiologyHistory'];
    for (const [when, w, trainingLeft] of [['2026-11-14T12:00:00', 6, true], ['2026-11-17T12:00:00', 7, false]] as const) {
      vi.setSystemTime(new Date(when));
      tri.w = w;
      hx.w = w;
      const triWeeks = predictTriathlonRace(tri)!.projection!.weeksRemaining;
      const p = predictHyroxRace(hx)!;
      const proj = buildHyroxProjection(hx, p);
      expect(triWeeks > 0, when).toBe(trainingLeft);
      expect(proj.weeksRemaining > 0, when).toBe(trainingLeft);
      expect(proj.factors.some(f => f.name === 'Race-day readiness'), when).toBe(true);
    }
  });
});
