import { describe, it, expect } from 'vitest';
import {
  plannedSessionsPerWeekByDiscipline,
  recentHoursByDiscipline,
  longestSessionByDiscipline,
} from './tri-volume-by-discipline';
import type { SimulatorState } from '@/types/state';

/** ISO string `daysAgo` days before now. */
const isoDaysAgo = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

/**
 * The `startOffset` argument lets the injury-aware predictor sample the
 * *recovered* dose. The plan weeks after every restricted discipline has
 * returned. Instead of the injured transition weeks that would understate the
 * steady-state plan.
 */
function stateWith(weeks: Array<{ swim: number; bike: number; run: number }>): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: weeks.map(c => ({
      triWorkouts: [
        ...Array.from({ length: c.swim }, (_, i) => ({ id: `s${i}`, discipline: 'swim' })),
        ...Array.from({ length: c.bike }, (_, i) => ({ id: `b${i}`, discipline: 'bike' })),
        ...Array.from({ length: c.run }, (_, i) => ({ id: `r${i}`, discipline: 'run' })),
      ],
    })),
  } as any;
}

describe('plannedSessionsPerWeekByDiscipline — startOffset', () => {
  // Weeks 0-1: injured (swim/run zeroed, bike only). Weeks 2-5: recovered.
  const injuredThenRecovered = stateWith([
    { swim: 0, bike: 3, run: 0 },
    { swim: 0, bike: 3, run: 0 },
    { swim: 3, bike: 3, run: 3 },
    { swim: 3, bike: 3, run: 3 },
    { swim: 3, bike: 3, run: 3 },
    { swim: 3, bike: 3, run: 3 },
  ]);

  it('offset 0 sees the injured transition weeks (swim/run suppressed)', () => {
    const v = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, 0);
    // 4-week window weeks 0-3: swim = (0+0+3+3)/4 = 1.5.
    expect(v.swim).toBeCloseTo(1.5, 5);
    expect(v.bike).toBeCloseTo(3, 5);
  });

  it('offset past the recovery window sees the full recovered dose', () => {
    const v = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, 2);
    // Weeks 2-5 all recovered → swim/run = 3.
    expect(v.swim).toBeCloseTo(3, 5);
    expect(v.run).toBeCloseTo(3, 5);
  });

  it('negative offset is clamped to 0', () => {
    const a = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, -5);
    const b = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, 0);
    expect(a.swim).toBe(b.swim);
  });
});

/**
 * After a fresh sign-in `wks[].garminActuals` is empty until activities
 * re-match forward. The persisted `recentDisciplineActivity` summary keeps
 * swim/bike volume + longest-session non-zero so the Endurance readiness card
 * doesn't collapse to 0. (Run is covered separately via onboardingRunHistory.)
 */
describe('recentDisciplineActivity fallback — sign-in resilience', () => {
  const signedInState = (): SimulatorState => ({
    eventType: 'triathlon',
    w: 0,
    wks: [{ garminActuals: {} }], // empty — mirrors a fresh sign-in
    recentDisciplineActivity: [
      { activityType: 'SWIMMING', startTime: isoDaysAgo(3), durationSec: 2400, distanceKm: 1.5 }, // 0.67 h
      { activityType: 'CYCLING', startTime: isoDaysAgo(5), durationSec: 7200, distanceKm: 60 },   // 2.0 h
      { activityType: 'CYCLING', startTime: isoDaysAgo(12), durationSec: 12600, distanceKm: 110 }, // 3.5 h (longest)
      { activityType: 'RUNNING', startTime: isoDaysAgo(2), durationSec: 3000, distanceKm: 8 },     // 0.83 h
    ],
  } as any);

  it('recovers swim/bike/run weekly hours when garminActuals is empty', () => {
    const v = recentHoursByDiscipline(signedInState(), 8);
    // Totals divided by the 8-week window.
    expect(v.swim).toBeCloseTo(2400 / 3600 / 8, 5);
    expect(v.bike).toBeCloseTo((7200 + 12600) / 3600 / 8, 5);
    expect(v.run).toBeCloseTo(3000 / 3600 / 8, 5);
  });

  it('recovers longest single session per discipline when garminActuals is empty', () => {
    const longest = longestSessionByDiscipline(signedInState(), 12);
    expect(longest.swim).toBe(2400);
    expect(longest.bike).toBe(12600); // the 3.5 h ride, not the 2.0 h one
    expect(longest.run).toBe(3000);
  });

  it('excludes persisted entries older than the requested window', () => {
    const s = signedInState();
    (s as any).recentDisciplineActivity.push({
      activityType: 'CYCLING', startTime: isoDaysAgo(90), durationSec: 18000, distanceKm: 150,
    });
    // 90 days ago is outside an 8-week (56-day) window, so it must not appear.
    const v = recentHoursByDiscipline(s, 8);
    expect(v.bike).toBeCloseTo((7200 + 12600) / 3600 / 8, 5);
  });

  it('does not double-count an activity present in both garminActuals and the summary', () => {
    const sharedTime = isoDaysAgo(4);
    const s = {
      eventType: 'triathlon',
      w: 0,
      wks: [{ garminActuals: { b1: { activityType: 'CYCLING', startTime: sharedTime, durationSec: 5400, distanceKm: 45 } } }],
      recentDisciplineActivity: [
        // Same ride (within ±10 min) as the garminActuals entry — must dedupe.
        { activityType: 'CYCLING', startTime: sharedTime, durationSec: 5400, distanceKm: 45 },
      ],
    } as any;
    const v = recentHoursByDiscipline(s, 8);
    expect(v.bike).toBeCloseTo(5400 / 3600 / 8, 5); // counted once, not twice
  });
});
