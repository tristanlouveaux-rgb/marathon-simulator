import { describe, it, expect } from 'vitest';
import { runMarathonForecastSim } from './race-forecast-simulation';
import type { SimulatorState } from '@/types';

/**
 * Regression: the Monte Carlo cone must anchor to the displayed blended
 * prediction, not to `s.forecastTime`.
 *
 * Real incident (2026-06-01): an athlete whose PBs outpaced their synced-run
 * VDOT saw the Race Forecast page show an initial prediction of 17:55 but a
 * Monte Carlo median of 19:37 — the cone predicted regression over a 13-week
 * block and collapsed the goal probability to <5%. Root cause: today's anchor
 * came from `blendedRaceTimeSec` (PB-fast) while race-day came from
 * `forecastTime` (VDOT-slow). They disagreed by ~2 min, so the cone sloped the
 * wrong way. The fix derives race-day from the same blended anchor.
 */

// Minimal state exercising only the fields the simulator reads.
function pbDivergentState(): SimulatorState {
  return {
    rd: '5k',
    // Synced-run VDOT implies ~19:57 over 5K.
    v: 50,
    blendedEffectiveVdot: 50,
    // Headline blended prediction is PB-pulled to ~17:55 — much faster than VDOT.
    blendedRaceTimeSec: 1075,
    // forecastTime left at a raw-VDOT-ish ~19:30: this is exactly the value that
    // used to anchor the race-day end of the cone and broke it.
    forecastTime: 1170,
    tw: 14,
    w: 1,
    epw: 4,
    rw: 4,
    typ: 'Balanced',
    pbs: {},
    lt: null,
  } as unknown as SimulatorState;
}

describe('runMarathonForecastSim — blended-anchor coherence', () => {
  it('cone improves from the blended headline (does not predict regression)', () => {
    const sim = runMarathonForecastSim(pbDivergentState(), 2000);
    expect(sim).not.toBeNull();
    // Race-day median must be at least as fast as today's blended prediction.
    // (Pre-fix it landed ~100s SLOWER — the regression bug.)
    expect(sim!.raceDay.p50).toBeLessThanOrEqual(1075);
  });

  it('goal probability of beating the headline is sane, not collapsed to <5%', () => {
    const goalSec = 1075; // beat the initial blended prediction itself
    const sim = runMarathonForecastSim(pbDivergentState(), 2000, goalSec);
    expect(sim).not.toBeNull();
    // Median sits at/below the goal, so roughly half the trials beat it.
    // Pre-fix this was <0.05 because the whole cone sat slower than the goal.
    expect(sim!.goalProbability).not.toBeNull();
    expect(sim!.goalProbability!).toBeGreaterThan(0.4);
  });

  it('a stretch goal faster than the forecast still reads as a low chance', () => {
    // Anchoring to the headline must not make every goal look easy: a goal well
    // below the improved median should still be a tail outcome.
    const stretch = 950; // ~15:50, faster than the improving median
    const sim = runMarathonForecastSim(pbDivergentState(), 2000, stretch);
    expect(sim!.goalProbability!).toBeLessThan(0.25);
  });
});

describe('runMarathonForecastSim — centres on the displayed forecast', () => {
  // A coherent state: forecast (faster than today) is the number the UI shows.
  // The cone must centre on it so "goal == forecast" reads ~50%, not ~32%.
  function coherentState(): SimulatorState {
    return {
      rd: 'marathon',
      v: 43.5,
      blendedEffectiveVdot: 43.5,
      blendedRaceTimeSec: 12850, // ~3:34 today
      forecastTime: 12262,       // ~3:24:22 displayed forecast (improvement)
      tw: 40,
      w: 1,
      epw: 4,
      rw: 4,
      typ: 'Balanced',
      pbs: {},
      lt: null,
      onboarding: { experienceLevel: 'intermediate' },
    } as unknown as SimulatorState;
  }

  it('goal == displayed forecast reads ~50%', () => {
    const sim = runMarathonForecastSim(coherentState(), 4000, 12262);
    expect(sim!.goalProbability!).toBeGreaterThan(0.42);
    expect(sim!.goalProbability!).toBeLessThan(0.58);
  });

  it('race-day median equals the displayed forecast (within a few seconds)', () => {
    const sim = runMarathonForecastSim(coherentState(), 4000);
    expect(Math.abs(sim!.raceDay.p50 - 12262)).toBeLessThan(30);
  });

  it('a faster forecast override (more sessions) raises the goal chance', () => {
    // Same goal, two scenarios: the "add a session" path passes a faster
    // forecast override. The chance must rise with it, not stay pinned to the
    // base forecast.
    const goal = 12000; // 3:20:00
    const base = runMarathonForecastSim(coherentState(), 4000, goal, 12262);   // 3:24:22
    const withSession = runMarathonForecastSim(coherentState(), 4000, goal, 11940); // 3:19:00
    expect(withSession!.goalProbability!).toBeGreaterThan(base!.goalProbability! + 0.1);
  });
});
