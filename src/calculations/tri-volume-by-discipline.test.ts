import { describe, it, expect } from 'vitest';
import {
  plannedSessionsPerWeekByDiscipline,
  plannedBuildDoseByDiscipline,
  plannedPeakDoseByDiscipline,
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
 * `plannedBuildDoseByDiscipline` averages the planned dose across remaining
 * BUILD weeks (non-taper) instead of the next-4-week window, so an early-plan
 * base phase no longer under-credits the projection's horizon gain.
 */
describe('plannedBuildDoseByDiscipline — build-average vs next-4 window', () => {
  function rampState(
    weeks: Array<{ ph?: string; swim?: number; bike?: number; run?: number; minPer?: number }>,
  ): SimulatorState {
    return {
      eventType: 'triathlon',
      w: 0,
      wks: weeks.map(c => ({
        ph: c.ph,
        triWorkouts: [
          ...Array.from({ length: c.swim ?? 0 }, (_, i) => ({ id: `s${i}`, discipline: 'swim', estimatedDurationMin: c.minPer ?? 60 })),
          ...Array.from({ length: c.bike ?? 0 }, (_, i) => ({ id: `b${i}`, discipline: 'bike', estimatedDurationMin: c.minPer ?? 60 })),
          ...Array.from({ length: c.run ?? 0 }, (_, i) => ({ id: `r${i}`, discipline: 'run', estimatedDurationMin: c.minPer ?? 60 })),
        ],
      })),
    } as any;
  }

  it('build average exceeds the next-4-week dose when the plan ramps', () => {
    const s = rampState([
      { ph: 'base',  bike: 2 },
      { ph: 'build', bike: 4 },
      { ph: 'peak',  bike: 6 },
      { ph: 'taper', bike: 2 },
    ]);
    const next4 = plannedSessionsPerWeekByDiscipline(s, 4, 0).bike; // (2+4+6+2)/4 = 3.5
    const build = plannedBuildDoseByDiscipline(s).sessions.bike;    // (2+4+6)/3 = 4.0
    expect(next4).toBeCloseTo(3.5, 5);
    expect(build).toBeCloseTo(4, 5);
    expect(build).toBeGreaterThan(next4);
  });

  it('excludes taper weeks from the average (extra taper weeks do not drag it down)', () => {
    const s = rampState([
      { ph: 'base', bike: 2 }, { ph: 'build', bike: 4 }, { ph: 'peak', bike: 6 },
      { ph: 'taper', bike: 1 }, { ph: 'taper', bike: 1 },
    ]);
    // Still (2+4+6)/3 = 4.0 — the two low-volume taper weeks are ignored.
    expect(plannedBuildDoseByDiscipline(s).sessions.bike).toBeCloseTo(4, 5);
  });

  it('averages planned hours from estimatedDurationMin', () => {
    const s = rampState([{ ph: 'build', bike: 3, minPer: 60 }]); // 3 × 60min = 3h
    expect(plannedBuildDoseByDiscipline(s).hours.bike).toBeCloseTo(3, 5);
  });

  it('treats a week with no phase set as a build week (counted)', () => {
    const s = rampState([{ bike: 3 }, { bike: 5 }]); // no ph → both counted
    expect(plannedBuildDoseByDiscipline(s).sessions.bike).toBeCloseTo(4, 5);
  });

  it('falls back to the 4-week look-ahead (never zero) when only taper weeks remain', () => {
    const s = rampState([{ ph: 'taper', bike: 2 }, { ph: 'taper', bike: 2 }]);
    const build = plannedBuildDoseByDiscipline(s).sessions.bike;
    const next4 = plannedSessionsPerWeekByDiscipline(s, 4, 0).bike;
    expect(build).toBeGreaterThan(0);
    expect(build).toBeCloseTo(next4, 5); // fell back, didn't return 0
  });

  it('respects startOffset (samples the recovered dose past injury weeks)', () => {
    const s = rampState([
      { ph: 'base', bike: 2 }, { ph: 'base', bike: 2 },
      { ph: 'build', bike: 6 }, { ph: 'peak', bike: 6 },
    ]);
    // Offset 2 skips the two base weeks → (6+6)/2 = 6.
    expect(plannedBuildDoseByDiscipline(s, 2).sessions.bike).toBeCloseTo(6, 5);
  });

  // ── Peak dose (drives the race-readiness penalty closure) ──────────────────
  it('peak dose reads the mean of peak-phase weeks (above the build mean)', () => {
    const s = rampState([
      { ph: 'base',  bike: 2 },
      { ph: 'build', bike: 4 },
      { ph: 'peak',  bike: 6 },
      { ph: 'peak',  bike: 6 },
      { ph: 'taper', bike: 2 },
    ]);
    const build = plannedBuildDoseByDiscipline(s).sessions.bike; // (2+4+6+6)/4 = 4.5
    const peak  = plannedPeakDoseByDiscipline(s).sessions.bike;  // mean of peak weeks = 6
    expect(build).toBeCloseTo(4.5, 5);
    expect(peak).toBeCloseTo(6, 5);
    expect(peak).toBeGreaterThan(build);
  });

  it('peak dose averages hours over peak-phase weeks', () => {
    const s = rampState([
      { ph: 'build', bike: 2, minPer: 120 },
      { ph: 'peak',  bike: 3, minPer: 120 }, // 6h
      { ph: 'peak',  bike: 4, minPer: 120 }, // 8h
    ]);
    // Peak weeks only: (6 + 8) / 2 = 7h.
    expect(plannedPeakDoseByDiscipline(s).hours.bike).toBeCloseTo(7, 5);
  });

  it('peak dose falls back to the max non-taper week when no peak phase is labelled', () => {
    const s = rampState([
      { ph: 'base',  bike: 2 },
      { ph: 'build', bike: 5 }, // the highest non-taper week
      { ph: 'build', bike: 3 },
    ]);
    expect(plannedPeakDoseByDiscipline(s).sessions.bike).toBeCloseTo(5, 5);
  });

  it('peak dose falls back to the build dose when only taper weeks remain', () => {
    const s = rampState([{ ph: 'taper', bike: 2 }, { ph: 'taper', bike: 2 }]);
    const peak = plannedPeakDoseByDiscipline(s).sessions.bike;
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeCloseTo(plannedBuildDoseByDiscipline(s).sessions.bike, 5);
  });

  // ── Race-window cut (Week.raceWindowCut) ───────────────────────────────────
  // The race window removes sessions from the week before race week of a
  // Thursday to Saturday race (planning, taper placement). The dose helpers
  // read the week as prescribed before the cut, so the forecast does not count
  // the taper placement as lost training.
  it('build and peak dose add the race window cut back to its week', () => {
    const s = rampState([
      { ph: 'build', bike: 3, minPer: 60 },
      { ph: 'peak',  bike: 2, minPer: 60 }, // window removed 2 x 90-min bike sessions
      { ph: 'taper', bike: 1, minPer: 30 },
    ]);
    (s.wks[1] as any).raceWindowCut = [
      { discipline: 'bike', estimatedDurationMin: 90 },
      { discipline: 'bike', estimatedDurationMin: 90 },
    ];
    // Peak week as prescribed: 4 sessions, 2h + 3h = 5h.
    expect(plannedPeakDoseByDiscipline(s).sessions.bike).toBeCloseTo(4, 5);
    expect(plannedPeakDoseByDiscipline(s).hours.bike).toBeCloseTo(5, 5);
    // Build mean over the two non-taper weeks: (3 + 4) / 2 sessions, (3 + 5) / 2 hours.
    expect(plannedBuildDoseByDiscipline(s).sessions.bike).toBeCloseTo(3.5, 5);
    expect(plannedBuildDoseByDiscipline(s).hours.bike).toBeCloseTo(4, 5);
  });

  it('the next-4-week look-ahead shows the plan as scheduled (the cut stays out)', () => {
    const s = rampState([{ ph: 'peak', bike: 2, minPer: 60 }]);
    (s.wks[0] as any).raceWindowCut = [{ discipline: 'bike', estimatedDurationMin: 90 }];
    expect(plannedSessionsPerWeekByDiscipline(s, 4, 0).bike).toBeCloseTo(2, 5);
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
