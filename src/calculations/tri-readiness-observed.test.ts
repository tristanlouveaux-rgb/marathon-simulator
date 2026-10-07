/**
 * Triathlon / cycling per-discipline readiness for an athlete with no record
 * before plan start: days before it are unknown, not rest.
 *
 * Regression (cross-mode verification F3, tri + cycling): the per-discipline
 * EMAs start from zero, so a new triathlete running 50 TSS every other day read
 * run ATL/CTL 4.41 / 3.43 / 2.63 / 2.26 on days 7 / 14 / 21 / 28, label
 * Overreaching each time, sentence "Run load is high relative to your baseline.
 * Reduce run volume this week.", while the shared rolling ACWR on the Home ring
 * read the same training as safe. A cyclist riding 60 min a day read the same.
 * Rule (Tristan, 2026-10-06): when no activity of any sport was recorded before
 * plan start, the days before it count as unknown. A runner with years of
 * history who has just started swimming keeps the swim ramp warning.
 */
import { describe, it, expect } from 'vitest';
import { computeTriReadiness } from './tri-readiness';
import {
  buildTriFitnessHistory,
  estimateDirectPerDisciplineCTLFromActivities,
  triLoadObservedDays,
} from './tri-benchmarks-from-history';
import { observedDisciplineLoad, perDisciplineACWR } from './fitness-model.triathlon';
import { getAthleteNormalizer } from './fitness-model';
import type { SimulatorState } from '@/types/state';

const DAY = 86400000;
const REF = Date.parse('2026-09-01T12:00:00.000Z');
const REF_ISO = new Date(REF).toISOString();

type Act = { activityType: string; durationSec: number; startTime: string; iTrimp: number; distanceKm: number };

/** An activity worth `tss` canonical TSS, `daysAgo` days before REF. iTRIMP is
 *  encoded with the athlete normalizer so estimateTss decodes exactly `tss`. */
function act(type: string, daysAgo: number, tss: number, minutes = 60): Act {
  return {
    activityType: type,
    durationSec: minutes * 60,
    startTime: new Date(REF - daysAgo * DAY).toISOString(),
    iTrimp: (tss * getAthleteNormalizer()) / 100,
    distanceKm: 10,
  };
}

/** Plan start `days` days before REF, as the ISO date the app stores. */
function planStartDaysAgo(days: number): string {
  return new Date(REF - days * DAY).toISOString().slice(0, 10);
}

/** State built the way main.ts builds it at launch. */
function stateFor(acts: Act[], planStartDate: string, cycling = false): SimulatorState {
  const direct = estimateDirectPerDisciplineCTLFromActivities(acts, REF_ISO);
  return {
    eventType: 'triathlon',
    w: 1,
    wks: [],
    planStartDate,
    physiologyHistory: [],
    recentLegLoads: [],
    triConfig: {
      ...(cycling ? { disciplines: ['bike'] } : {}),
      fitness: {
        swim: direct.swim, bike: direct.bike, run: direct.run,
        combinedCtl: direct.combinedCtl,
        crossTrainingAtl: direct.crossTrainingAtl,
        crossTrainingCtl: direct.crossTrainingCtl,
        loadObservedDays: triLoadObservedDays(acts, planStartDate, REF_ISO),
      },
      fitnessHistory: buildTriFitnessHistory(acts, REF_ISO),
    },
  } as unknown as SimulatorState;
}

/** 50 TSS run every other day from plan start (day `planDays` ago) to today. */
function runsEveryOtherDay(planDays: number, sport = 'RUNNING', tss = 50): Act[] {
  const out: Act[] = [];
  for (let d = planDays; d >= 0; d -= 2) out.push(act(sport, d, tss));
  return out;
}

describe('triLoadObservedDays', () => {
  const start = planStartDaysAgo(20);

  it('counts completed days since plan start when nothing predates it', () => {
    expect(triLoadObservedDays([act('RUNNING', 3, 50)], start, REF_ISO)).toBe(20);
    expect(triLoadObservedDays([], start, REF_ISO)).toBe(20);
  });

  it('any earlier activity, of any sport, means the record covers the window', () => {
    expect(triLoadObservedDays([act('RUNNING', 3, 50), act('HIIT', 40, 30)], start, REF_ISO)).toBeUndefined();
    expect(triLoadObservedDays([act('LAP_SWIMMING', 300, 30)], start, REF_ISO)).toBeUndefined();
  });

  it('no plan start: undefined (stored EMAs read as they are)', () => {
    expect(triLoadObservedDays([act('RUNNING', 3, 50)], undefined, REF_ISO)).toBeUndefined();
  });
});

describe('observedDisciplineLoad', () => {
  it('returns the stored values unchanged when the record covers the window', () => {
    expect(observedDisciplineLoad({ ctl: 40, atl: 55, tsb: -15 }, undefined)).toEqual({ ctl: 40, atl: 55, tsb: -15 });
  });

  it('steady training reads the same as for an athlete whose record covers the window', () => {
    // 50 TSS every day. Veteran: 200 days of it. New athlete: 29 days, nothing before.
    const daily = (days: number) => Array.from({ length: days + 1 }, (_, i) => act('RUNNING', i, 50));
    const vet = estimateDirectPerDisciplineCTLFromActivities(daily(200), REF_ISO).run;
    const fresh = estimateDirectPerDisciplineCTLFromActivities(daily(28), REF_ISO).run;
    const corrected = observedDisciplineLoad(fresh, 28);
    expect(Math.abs(corrected.ctl - vet.ctl) / vet.ctl).toBeLessThan(0.01);
    expect(Math.abs(corrected.atl - vet.atl) / vet.atl).toBeLessThan(0.01);
  });
});

describe('computeTriReadiness: no record before plan start', () => {
  for (const day of [7, 14, 21, 28]) {
    it(`steady runs, day ${day}: run is not Overreaching and no "reduce volume" sentence`, () => {
      const acts = runsEveryOtherDay(day);
      const r = computeTriReadiness(stateFor(acts, planStartDaysAgo(day)))!;
      expect(r).not.toBeNull();
      expect(r.run.label).not.toBe('Overreaching');
      expect(r.run.hardFloor).not.toBe('acwr');
      expect(r.sentence).not.toMatch(/high relative to your baseline/);
    });
  }

  it('the displayed workload ratio is unknown for the first 14 days, then reads the steady ratio', () => {
    const vetActs = runsEveryOtherDay(200);
    const vet = stateFor(vetActs, planStartDaysAgo(28));
    expect(vet.triConfig!.fitness!.loadObservedDays).toBeUndefined();
    const vetRatio = perDisciplineACWR(vet.triConfig!.fitness!.run)!;

    const early = stateFor(runsEveryOtherDay(10), planStartDaysAgo(10));
    expect(perDisciplineACWR(early.triConfig!.fitness!.run, early.triConfig!.fitness!.loadObservedDays)).toBeUndefined();

    const s = stateFor(runsEveryOtherDay(28), planStartDaysAgo(28));
    const f = s.triConfig!.fitness!;
    const raw = perDisciplineACWR(f.run)!;
    const observed = perDisciplineACWR(f.run, f.loadObservedDays)!;
    expect(raw).toBeGreaterThan(2);                       // the old reading
    expect(Math.abs(observed - vetRatio)).toBeLessThan(0.1); // same as a veteran
  });

  for (const day of [14, 21, 28]) {
    it(`cycling, 60 min a day, day ${day}: bike is not Overreaching`, () => {
      const acts: Act[] = [];
      for (let d = day; d >= 0; d--) acts.push(act('CYCLING', d, 60));
      const r = computeTriReadiness(stateFor(acts, planStartDaysAgo(day), true))!;
      expect(r.bike.label).not.toBe('Overreaching');
      expect(r.sentence).not.toMatch(/Bike load is high relative to your baseline/);
    });
  }
});

describe('computeTriReadiness: a record before plan start keeps the new-sport ramp', () => {
  it('a runner of 120 days who starts swimming at plan start still reads the swim spike', () => {
    const acts: Act[] = [];
    for (let d = 134; d >= 0; d--) acts.push(act('RUNNING', d, 50));
    for (let d = 14; d >= 0; d -= 2) acts.push(act('LAP_SWIMMING', d, 50));
    const s = stateFor(acts, planStartDaysAgo(14));
    expect(s.triConfig!.fitness!.loadObservedDays).toBeUndefined();
    const r = computeTriReadiness(s)!;
    expect(r.swim.label).toBe('Overreaching');
    expect(r.run.label).not.toBe('Overreaching');
  });
});
