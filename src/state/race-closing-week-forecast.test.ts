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
 * Removes and returns the race week's Sunday sessions. A Monday to Wednesday
 * race's race week can keep a Sunday session (R-1) that the Sunday-before race
 * loses to race day: HYROX keeps its race-week easy run there. That is plan
 * content (planning), not forecast horizon, and the HYROX forecast's
 * next-4-week session count reads it (at most 2 s faster). Removing it leaves
 * exactly the Sunday-before plan's training weeks.
 */
function takeRaceWeekSunday(s: SimulatorState): Workout[] {
  const wk = s.wks[planTrainingWeeks(s) - 1];
  const all = wk.triWorkouts ?? [];
  wk.triWorkouts = all.filter(w => w.dayOfWeek !== 6);
  return all.filter(w => w.dayOfWeek === 6);
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
            let sundayRaceWeek: Workout[] = [];
            const early = forecasts(mode, race, now, sunWeeks, s => { sundayRaceWeek = takeRaceWeekSunday(s); });
            // Triathlon and cycling race weeks hold nothing on the Sunday; HYROX at most its easy run.
            if (mode === 'hyrox') {
              expect(sundayRaceWeek.length, `${mode} ${day} ${race}`).toBeLessThanOrEqual(1);
              for (const w of sundayRaceWeek) expect(w.n, `${mode} ${day} ${race}`).toMatch(/easy/i);
            } else {
              expect(sundayRaceWeek, `${mode} ${day} ${race}`).toEqual([]);
            }
            // Same training weeks, plus the closing week.
            expect(early.s.tw, `${mode} ${day} ${race}`).toBe(sunWeeks + 1);
            expect(early.s.wks[early.s.tw - 1].raceClosing, `${mode} ${day} ${race}`).toBe(true);
            expect(planTrainingWeeks(early.s)).toBe(sunWeeks);
            early.out.forEach((f, i) => {
              expect(f, `${mode} ${day} ${race}, ${i === 0 ? 'plan creation' : `week ${i}`}`).toEqual(sun.out[i]);
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
