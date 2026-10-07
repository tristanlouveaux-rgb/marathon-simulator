import { describe, it, expect } from 'vitest';
import { refreshBlendedFitness } from './blended-fitness';
import { runMarathonForecastSim } from './race-forecast-simulation';
import { raceDayPlanDurability } from './race-day-durability';
import { resolvePlannedWeekPhase, computePlannedWeekTarget } from './planned-week-target';
import { initializeWeeks } from '@/workouts/generator';
import type { SimulatorState, Week } from '@/types';

/**
 * A Monday to Wednesday race has a closing week (its own week, holding only the
 * race) inside s.tw. Every weeks-to-race input reads training weeks
 * (planTrainingWeeks), so a Tuesday race must forecast exactly like the Sunday
 * before it: same forecast, same race-day durability, same Monte Carlo cone,
 * same taper targets (M4 design v4 review, major 2).
 */

function marathonState(closing: boolean): SimulatorState {
  const wks: Week[] = initializeWeeks(6, { raceDistance: 'marathon' });
  if (closing) {
    wks.push({ w: 7, ph: 'taper', raceClosing: true, rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0 } as Week);
  }
  return {
    schemaVersion: 1,
    w: 1, tw: wks.length, v: 45, iv: 45, rpeAdj: 0,
    rd: 'marathon', eventType: 'running', continuousMode: false,
    epw: 4, rw: 4, wkm: 40, detectedWeeklyKm: 40,
    athleteArchetype: { archetype: 'consistent-runner' },
    onboarding: { experienceLevel: 'intermediate', customRaceDate: closing ? '2026-11-17' : '2026-11-15' },
    planStartDate: '2026-10-05',
    sharpenBlock: { v: 1, startLongMin: 100, startSource: 'history-30d', recentLongestMin: 100, noSignal: false, trainingWeeks: 6, builtISO: '2026-10-05' },
    pbs: { h: 100 * 60 }, rec: null, lt: null, vo2: null,
    initialLT: null, initialVO2: null, initialBaseline: null,
    currentFitness: null, forecastTime: null,
    typ: 'Balanced', calculatedRunnerType: 'Balanced',
    b: 1.06, wks,
    pac: { e: 330, t: 280, i: 255, m: 300, r: 240 },
    skip: [], timp: 0, expectedFinal: 45,
    restingHR: 50, maxHR: 190,
    historicWeeklyTSS: [300, 310, 320, 330, 340], ctlBaseline: 320, athleteTier: 'recreational',
  } as unknown as SimulatorState;
}

describe('closing week: a Tuesday race forecasts like the Sunday before', () => {
  it('same race-day durability and forecast', () => {
    const sun = marathonState(false);
    const tue = marathonState(true);
    expect(tue.tw).toBe(sun.tw + 1);
    expect(raceDayPlanDurability(tue)).toEqual(raceDayPlanDurability(sun));
    refreshBlendedFitness(sun);
    refreshBlendedFitness(tue);
    expect(tue.forecastTime).toBeGreaterThan(0);
    expect(tue.forecastTime).toBe(sun.forecastTime);
    expect(tue.expectedFinal).toBe(sun.expectedFinal);
  });

  it('same Monte Carlo cone', () => {
    const sun = marathonState(false);
    const tue = marathonState(true);
    refreshBlendedFitness(sun);
    refreshBlendedFitness(tue);
    const a = runMarathonForecastSim(sun);
    const b = runMarathonForecastSim(tue);
    expect(b).not.toBeNull();
    expect(b!.raceDay.p50).toBeGreaterThan(0);
    expect(b!.raceDay).toEqual(a!.raceDay);
  });

  it('taper targets: the taper keeps its length and positions; the closing week targets the race-week row', () => {
    const sun = marathonState(false);
    const tue = marathonState(true);
    expect([5, 6].map(w => resolvePlannedWeekPhase(tue, w))).toEqual([5, 6].map(w => resolvePlannedWeekPhase(sun, w)));
    expect(resolvePlannedWeekPhase(tue, 7)).toMatchObject({ phase: 'taper', weekInTaper: 2, taperWeeks: 2 });
    expect(computePlannedWeekTarget(tue, 7)).toBe(computePlannedWeekTarget(sun, 6));
  });
});
