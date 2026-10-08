/**
 * The triathlon forecast reads the plan's build prescription, not the race
 * window's taper cut (CLAUDE.md "Tracking vs Planning").
 *
 * For a Thursday to Saturday race, the race window (race-day-rules
 * clearStoredPlanRaceWindow) clears the last 1 to 3 days of the week before
 * race week and drops the sessions its moved long sessions displace. That week
 * is often labelled build or peak, so the forecast's planned-dose helpers
 * (plannedBuildDoseByDiscipline, plannedPeakDoseByDiscipline) read the cut as
 * lost training. On 92f701d an Ironman on Thursday 19 Nov 2026 (onboarding
 * Sunday 11 Oct) forecast 14.6 min slower than the same race on Sunday 15 Nov;
 * on 6df2908, before the race window existed, it was 7.9 min faster. The
 * generator now keeps the removed sessions' dose on the week
 * (Week.raceWindowCut) and the dose helpers add it back, so the forecast is
 * the same with or without the race window, as running's forecast reads
 * plan-engine targets rather than the race-day-rule output.
 *
 * The forecast is checked at plan creation and on the Monday of every plan
 * week. Once only taper weeks remain ahead, the dose helpers fall back to a
 * 4-week look-ahead, which reads the cut too: on f45244e it did not, and an
 * Ironman on Thursday 17 Dec 2026 forecast 3.6 min slower with the window on
 * Monday 30 Nov (s.w = 9).
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';

const ctl = vi.hoisted(() => ({ windowOn: true }));
vi.mock('@/workouts/race-day-rules', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/workouts/race-day-rules')>();
  const clear: typeof m.clearStoredPlanRaceWindow = (w, inp) =>
    (ctl.windowOn ? m.clearStoredPlanRaceWindow(w, inp) : w);
  return { ...m, clearStoredPlanRaceWindow: clear };
});

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
import { getState, resetState } from './store';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { plannedBuildDoseByDiscipline, plannedPeakDoseByDiscipline } from '@/calculations/tri-volume-by-discipline';
import { isFourWeekCycleDeloadWeek } from '@/workouts/plan_engine';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week } from '@/types';
import type { TriathlonDistance } from '@/types/triathlon';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorageMock.clear(); ctl.windowOn = true; });
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

function at(localIso: string): void {
  process.env.TZ = 'Europe/London';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(localIso));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

interface Built {
  s: SimulatorState;
  totalSec: number;
  build: ReturnType<typeof plannedBuildDoseByDiscipline>;
  peak: ReturnType<typeof plannedPeakDoseByDiscipline>;
}

function build(distance: TriathlonDistance, race: string, windowOn = true): Built {
  ctl.windowOn = windowOn;
  resetState();
  initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: distance, experienceLevel: 'intermediate', customRaceDate: race,
  } as OnboardingState);
  const s = getState();
  const totalSec = predictTriathlonRace(s)?.totalSec ?? NaN;
  return { s, totalSec, build: plannedBuildDoseByDiscipline(s), peak: plannedPeakDoseByDiscipline(s) };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The forecast on the Monday of every plan week: the plan is built at `now`,
 * then for week k = 1 to tw the clock is set to 12:00 on week k's Monday and
 * s.w = k. Entry k-1 is week k's forecast (total seconds).
 */
function weeklyForecasts(distance: TriathlonDistance, race: string, now: string, windowOn: boolean): number[] {
  vi.setSystemTime(new Date(now));
  const { s } = build(distance, race, windowOn);
  const out: number[] = [];
  for (let k = 1; k <= s.tw; k++) {
    vi.setSystemTime(new Date(`${addDays(s.planStartDate!.slice(0, 10), 7 * (k - 1))}T12:00:00`));
    s.w = k;
    out.push(predictTriathlonRace(s)?.totalSec ?? NaN);
  }
  return out;
}

/** Per-discipline sessions and minutes of a list of sessions. */
function dose(ws: Array<{ discipline?: string; estimatedDurationMin?: number }>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = { swim: [0, 0], bike: [0, 0], run: [0, 0] };
  for (const w of ws) {
    if (!w.discipline || !(w.discipline in out)) continue;
    out[w.discipline][0] += 1;
    out[w.discipline][1] += w.estimatedDurationMin ?? 0;
  }
  return out;
}

/** Same dose up to summation order (the cut sessions are summed after the week's own). */
function expectSameDose(a: Built['build'], b: Built['build'], label: string): void {
  for (const k of ['sessions', 'hours'] as const) {
    for (const d of ['swim', 'bike', 'run'] as const) expect(a[k][d], `${label} ${k} ${d}`).toBeCloseTo(b[k][d], 9);
  }
}

const DISTANCES: TriathlonDistance[] = ['sprint', 'olympic', '70.3', 'ironman'];
// Onboarding on a Sunday (plan starts Monday 5 Oct) and on a Wednesday (Monday 12 Oct).
const ONBOARDING: Array<[string, string, string]> = [
  ['Sunday', '2026-10-11T12:00:00', '2026-10-11'],
  ['Wednesday', '2026-10-14T12:00:00', '2026-10-18'],
];
const LATER: Array<[string, number]> = [['Thursday', 4], ['Friday', 5], ['Saturday', 6]];

describe('the race window does not move the triathlon forecast', () => {
  it('Ironman on Thursday 19 Nov: the cut sessions plus the remaining week equal the week without the window', () => {
    at('2026-10-11T12:00:00');
    const on = build('ironman', '2026-11-19', true);
    const weekBefore = on.s.tw - 2; // race week is the final week (Thursday race, no closing week)
    const onWeek = structuredClone(on.s.wks[weekBefore]) as Week;
    const off = build('ironman', '2026-11-19', false);
    const offWeek = off.s.wks[weekBefore];

    // The window removed sessions from the week before race week, and only there.
    expect(onWeek.raceWindowCut?.length ?? 0).toBeGreaterThan(0);
    expect(off.s.wks.some(w => w.raceWindowCut)).toBe(false);
    // Remaining + cut = the week as generated without the window (sessions and minutes per discipline).
    expect(dose([...(onWeek.triWorkouts ?? []), ...(onWeek.raceWindowCut ?? [])])).toEqual(dose(offWeek.triWorkouts ?? []));
    expect(dose(onWeek.triWorkouts ?? [])).not.toEqual(dose(offWeek.triWorkouts ?? []));
  });

  for (const [onboardDay, now, firstSunday] of ONBOARDING) {
    for (const distance of DISTANCES) {
      it(`${distance}, ${onboardDay} onboarding: Thursday to Saturday races forecast the same with or without the race window`, () => {
        at(now);
        for (let weeksOut = 2; weeksOut <= 16; weeksOut++) {
          const sunday = addDays(firstSunday, 7 * weeksOut);
          for (const [day, offset] of LATER) {
            const race = addDays(sunday, offset);
            const on = build(distance, race, true);
            const off = build(distance, race, false);
            const label = `${distance} ${day} ${race}`;
            expect(on.totalSec, label).toBeGreaterThan(0);
            expect(on.totalSec, label).toBeCloseTo(off.totalSec, 6);
            expectSameDose(on.build, off.build, `${label} build`);
            expectSameDose(on.peak, off.peak, `${label} peak`);
          }
        }
      });
    }
  }

  // Later in the plan. Once only taper weeks remain ahead (the week before
  // race week of a Thursday to Saturday race is labelled taper), the planned
  // dose falls back to the 4-week look-ahead, which must count the cut too.
  // On f45244e an Ironman on Thursday 17 Dec 2026 (onboarding Sunday 11 Oct,
  // 11 weeks, cut on week 10) forecast 3.6 min slower with the window on
  // Monday 30 Nov (s.w = 9): 46138 s against 45920 s.
  it('Ironman on Thursday 17 Dec: the forecast on Monday 30 Nov (s.w = 9) is the same with or without the race window', () => {
    at('2026-10-11T12:00:00');
    const on = weeklyForecasts('ironman', '2026-12-17', '2026-10-11T12:00:00', true);
    const off = weeklyForecasts('ironman', '2026-12-17', '2026-10-11T12:00:00', false);
    expect(on.length).toBe(11);
    expect(on[8]).toBeGreaterThan(0);
    expect(on[8]).toBeCloseTo(off[8], 6);
    expect(on).toEqual(off);
  });

  for (const [onboardDay, now, firstSunday] of ONBOARDING) {
    for (const distance of ['70.3', 'ironman'] as TriathlonDistance[]) {
      it(`${distance}, ${onboardDay} onboarding: Thursday and Friday races forecast the same with or without the race window on every plan week`, () => {
        at(now);
        let weeksCompared = 0;
        for (let weeksOut = 2; weeksOut <= 14; weeksOut++) {
          const sunday = addDays(firstSunday, 7 * weeksOut);
          for (const [day, offset] of LATER.slice(0, 2)) {
            const race = addDays(sunday, offset);
            const on = weeklyForecasts(distance, race, now, true);
            const off = weeklyForecasts(distance, race, now, false);
            expect(on.length, `${distance} ${day} ${race}`).toBe(off.length);
            on.forEach((sec, i) => {
              const label = `${distance} ${day} ${race}, week ${i + 1} of ${on.length}`;
              expect(sec, label).toBeGreaterThan(0);
              expect(sec, label).toBeCloseTo(off[i], 6);
              weeksCompared += 1;
            });
          }
        }
        expect(weeksCompared).toBeGreaterThan(200);
      });
    }
  }

  it('Ironman, 6-week plan: a Thursday race forecasts no slower than the Sunday 4 days before (was 14.6 min slower)', () => {
    at('2026-10-11T12:00:00');
    const sun = build('ironman', '2026-11-15').totalSec;
    const thu = build('ironman', '2026-11-19').totalSec;
    expect(thu).toBeLessThanOrEqual(sun);
  });

  // 70.3 and Ironman, 4- to 8-week plans (Sunday race 3 to 7 weeks after a
  // Sunday onboarding). A Thursday to Saturday race has one more training week
  // than the Sunday before it. Where that extra week moves a 4-week-cycle
  // deload week (isFourWeekCycleDeloadWeek, x0.7) into the peak block, the
  // peak dose is lower whatever the race window does (70.3, Thursday 3 Dec:
  // +1.1 min, the same on 6df2908). Those cases (6 of 15 per distance, 3 and
  // 7 weeks out) are covered by the with-or-without-window test above and
  // skipped here.
  for (const distance of ['70.3', 'ironman'] as TriathlonDistance[]) {
    it(`${distance}, 4- to 8-week plans: a Thursday to Saturday race forecasts no slower than the Sunday before it`, () => {
      at('2026-10-11T12:00:00');
      const deloadInPeak = (s: SimulatorState) => s.wks.some(w => w.ph === 'peak' && isFourWeekCycleDeloadWeek(w.w, w.ph));
      let compared = 0;
      for (let weeksOut = 3; weeksOut <= 7; weeksOut++) {
        const sundayRace = addDays('2026-10-11', 7 * weeksOut);
        const sun = build(distance, sundayRace);
        const sunTotal = sun.totalSec;
        const sunDeload = deloadInPeak(sun.s);
        for (const [day, offset] of LATER) {
          const later = build(distance, addDays(sundayRace, offset));
          if (deloadInPeak(later.s) && !sunDeload) continue;
          compared += 1;
          expect(later.totalSec, `${distance} ${day}, ${weeksOut} weeks out`).toBeLessThanOrEqual(sunTotal);
        }
      }
      expect(compared).toBe(9);
    });
  }
});
