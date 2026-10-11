import { describe, it, expect } from 'vitest';
import { computePredictionInputs, resolveWeeklyKmSignal, type RunActivityInput } from './prediction-inputs';
import { calculateZones, raceEffortHrFloorBpm, raceEffortHrFloorForState, hrEffortProfile } from './heart-rate';

/**
 * Build a deterministic run N days before `anchor`, with given distance and
 * pace (sec/km). Keeps tests readable without Date math sprinkled around.
 */
function run(daysAgo: number, distKm: number, paceSecPerKm: number, anchor = new Date('2026-04-15T12:00:00Z')): RunActivityInput {
  const t = new Date(anchor.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    startTime: t.toISOString(),
    distKm,
    durSec: distKm * paceSecPerKm,
    activityType: 'RUNNING',
  };
}

describe('computePredictionInputs', () => {
  const NOW = new Date('2026-04-15T12:00:00Z');

  it('returns empty inputs when no runs', () => {
    const r = computePredictionInputs([], NOW);
    expect(r.weeklyKm).toBe(0);
    expect(r.avgPaceSecPerKm).toBeNull();
    expect(r.paceConfidence).toBe('none');
    expect(r.runsCounted).toBe(0);
  });

  it('filters walks (pace > 7:30/km) and sprints (pace < 3:00/km)', () => {
    const runs = [
      run(1, 5, 500),     // 8:20/km walk. Filtered
      run(2, 5, 150),     // 2:30/km sprint. Filtered
      run(3, 5, 300),     // 5:00/km. Kept
      run(4, 5, 300),
      run(5, 5, 300),
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(3);
  });

  it('filters runs shorter than 2 km', () => {
    const runs = [
      run(1, 1.5, 300),   // too short
      run(2, 5, 300),
      run(3, 5, 300),
      run(4, 5, 300),
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(3);
  });

  it('dedups Strava/Garmin dual-logs within 5-minute window', () => {
    const anchor = NOW;
    const a: RunActivityInput = { startTime: new Date(anchor.getTime() - 60_000 * 60).toISOString(), distKm: 10, durSec: 3000, activityType: 'RUNNING' };
    const b: RunActivityInput = { startTime: new Date(anchor.getTime() - 60_000 * 60 + 120_000).toISOString(), distKm: 10, durSec: 3000, activityType: 'RUNNING' };
    const r = computePredictionInputs([a, b, run(7, 8, 300), run(14, 8, 300)], NOW);
    expect(r.runsCounted).toBe(3); // dual-log collapsed to 1
  });

  it('computes K as mean weekly km across effective window', () => {
    // 4 weeks of 40 km/wk (8km run every other day)
    const runs: RunActivityInput[] = [];
    for (let d = 0; d < 28; d += 2) runs.push(run(d, 8, 300));
    const r = computePredictionInputs(runs, NOW);
    // 14 runs × 8 km = 112 km across ~4 weeks of coverage
    expect(r.weeklyKm).toBeGreaterThan(20);
    expect(r.weeklyKm).toBeLessThan(35);
    expect(r.weeksCovered).toBeGreaterThanOrEqual(4);
  });

  it('filters race-effort outliers from P but keeps them in K', () => {
    // 8 training runs at 5:00/km + one race at 4:00/km
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => run(i * 2 + 2, 10, 300)),
      run(1, 21, 240),  // race: 21km at 4:00/km. 20% faster than median
    ];
    const r = computePredictionInputs(runs, NOW);
    // P should exclude the race
    expect(r.avgPaceSecPerKm).toBeGreaterThan(290);
    expect(r.avgPaceSecPerKm).toBeLessThan(310);
    // K includes the race distance
    expect(r.weeklyKm).toBeGreaterThan(10);
  });

  it('marks data stale when most recent run >28 days old', () => {
    const runs = Array.from({ length: 5 }, (_, i) => run(30 + i * 2, 8, 300));
    const r = computePredictionInputs(runs, NOW);
    expect(r.isStale).toBe(true);
    expect(r.avgPaceSecPerKm).toBeNull(); // P gated on !isStale
  });

  it('assigns confidence tiers based on sample size', () => {
    // high: >=8 sessions, >=6 weeks
    const high = Array.from({ length: 10 }, (_, i) => run(i * 4, 8, 300));
    expect(computePredictionInputs(high, NOW).paceConfidence).toBe('high');

    // medium: >=4 sessions, >=3 weeks
    const medium = [run(1, 8, 300), run(8, 8, 300), run(15, 8, 300), run(22, 8, 300)];
    expect(computePredictionInputs(medium, NOW).paceConfidence).toBe('medium');

    // low: >=3 sessions within ~1 week
    const low = [run(1, 8, 300), run(3, 8, 300), run(5, 8, 300)];
    expect(computePredictionInputs(low, NOW).paceConfidence).toBe('low');

    // none: <3 sessions
    const none = [run(1, 8, 300), run(3, 8, 300)];
    expect(computePredictionInputs(none, NOW).paceConfidence).toBe('none');
  });

  it('shrinks effective window for new users — does not divide K by 8', () => {
    // Only 2 weeks of history, 5 runs total
    const runs = [
      run(1, 10, 300), run(3, 10, 300), run(5, 10, 300),
      run(8, 10, 300), run(12, 10, 300),
    ];
    const r = computePredictionInputs(runs, NOW);
    // 50 km across 2 weeks = ~25 km/wk. With 8-week div would be ~6. Bug.
    expect(r.weeklyKm).toBeGreaterThan(15);
    expect(r.weeksCovered).toBeLessThanOrEqual(3);
  });

  it('rejects activities named "Treadmill" or "Walk" even if pace is in band', () => {
    const runs: RunActivityInput[] = [
      { ...run(1, 5, 320), activityName: 'Treadmill 5K' },        // filtered by name
      { ...run(2, 5, 320), activityName: 'Lunchtime walk' },       // filtered by name
      { ...run(3, 5, 320), activityName: 'Easy Run' },
      { ...run(4, 5, 320), activityName: 'Tempo' },
      { ...run(5, 5, 320), activityName: 'Long Run' },
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(3);
  });

  it('drops the slowest 10% of remaining runs after hard filters', () => {
    // 10 runs: 9 at 4:30/km, 1 at 7:30/km (in-band but slowest). 10% drop = 1.
    const runs: RunActivityInput[] = [
      ...Array.from({ length: 9 }, (_, i) => run(i + 1, 8, 270)),
      run(11, 8, 450), // slowest tail. In band but should be dropped
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(9);
    // Average pace should reflect only the fast runs, not be pulled by 450
    expect(r.avgPaceSecPerKm).toBeCloseTo(270, 0);
  });

  it('skips slow-tail drop when fewer than 5 runs remain', () => {
    // 4 runs. Sample too small to safely trim.
    const runs: RunActivityInput[] = [
      run(1, 8, 270), run(3, 8, 270), run(5, 8, 270), run(7, 8, 450),
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(4);
  });

  it('rejects runs shorter than 3 km', () => {
    const runs = [
      run(1, 2.5, 300),     // too short under new threshold
      run(2, 3.0, 300),     // exact threshold. Kept
      run(3, 5, 300),
      run(4, 5, 300),
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(3);
  });

  it('populates recentRun with the newest race effort, not a newer training run', () => {
    // Median 340 s/km; the 10 km at 270 s/km is more than 15% faster (a race),
    // the newer runs are training.
    const runs = [run(2, 12, 345), run(5, 8, 340), run(12, 10, 270), run(15, 8, 335), run(20, 10, 350)];
    const r = computePredictionInputs(runs, NOW);
    expect(r.recentRun).not.toBeNull();
    expect(r.recentRun!.d).toBe(10);
    expect(r.recentRun!.t).toBe(2700);
    expect(r.recentRun!.weeksAgo).toBe(2);
    // The race stays out of P.
    expect(r.paceRunsCounted).toBe(4);
  });

  it('a window of training runs has no recent run, with or without heart rate', () => {
    // A 10K 45:00 runner's easy weeks (about 5:50/km). Pre-fix the newest easy
    // run filled the race slot and projected as a much slower race.
    const easy = [run(2, 16, 352), run(4, 8, 345), run(6, 6, 350), run(9, 16, 352), run(11, 8, 345), run(13, 6, 350)];
    expect(computePredictionInputs(easy, NOW).recentRun).toBeNull();
    const zone2 = easy.map(r => ({ ...r, avgHR: 140 }));
    expect(computePredictionInputs(zone2, NOW).recentRun).toBeNull();
    // Training runs still feed volume and P.
    const r = computePredictionInputs(easy, NOW);
    expect(r.runsCounted).toBe(6);
    expect(r.avgPaceSecPerKm).not.toBeNull();
  });
});

/**
 * Race test with heart rate (Tristan, 2026-10-09; floor moved 2026-10-11). Pace
 * alone reads a tempo run or a parkrun at tempo effort as a race. With an
 * average HR and known HR zones, a run counts as a race only at race level on
 * the HR effort scale: at or above the midpoint of the threshold zone (Z4),
 * above steady tempo effort (raceEffortHrFloorBpm). The top of Z4, the
 * 2026-10-09 floor, missed a 10K raced at 174 bpm.
 */
describe('computePredictionInputs: race test with heart rate', () => {
  const NOW = new Date('2026-04-15T12:00:00Z');
  // maxHR 190, resting 50 (Karvonen): Z4 threshold 162-176, midpoint 169.
  const PROFILE = { maxHR: 190, restingHR: 50 };
  const FLOOR = raceEffortHrFloorBpm(PROFILE)!;
  // Easy weeks at about 5:50/km plus one 5 km at 4:45/km ten days ago.
  const easy = [run(2, 16, 352), run(4, 8, 345), run(6, 6, 350), run(9, 16, 352), run(11, 8, 345), run(13, 6, 350)];
  const fast = (avgHR?: number): RunActivityInput => ({ ...run(10, 5, 285), ...(avgHR != null ? { avgHR } : {}) });

  it('the race floor is the midpoint of the threshold zone on the HR effort scale', () => {
    const zones = calculateZones(PROFILE)!;
    expect(FLOOR).toBe(169);
    expect(FLOOR).toBe((zones.z4.min + zones.z4.max) / 2);
    expect(FLOOR).toBeLessThan(zones.z5.min);
    // Max HR only: Z4 152 to 171, midpoint 161.5. No profile: no floor.
    expect(raceEffortHrFloorBpm({ maxHR: 190 })).toBe(161.5);
    expect(raceEffortHrFloorBpm({})).toBeNull();
    // The state helper reads the same profile as the per-activity HR effort score.
    expect(hrEffortProfile({ maxHR: 190, restingHR: 50, onboarding: { age: 40 } })).toEqual({ maxHR: 190, restingHR: 50, age: 40 });
    expect(raceEffortHrFloorForState({ maxHR: 190, restingHR: 50 })).toBe(169);
  });

  it('a tempo run at a steady-tempo HR is a training run, not a race', () => {
    const tempo = fast(165);  // lower half of Z4, 82% of reserve
    const r = computePredictionInputs([tempo, ...easy], NOW, FLOOR);
    expect(r.recentRun).toBeNull();
    // Pre-fix (pace-only) it was the recent race.
    expect(computePredictionInputs([tempo, ...easy], NOW).recentRun).toMatchObject({ d: 5, t: 1425 });
  });

  it("the HR test never changes Tanda's P: hard efforts stay out of it by pace", () => {
    // Review 2026-10-09: with the HR test on P, the tempo moved into P (7 runs)
    // and pulled P faster. P is pace-filtered, as at 81d38f7.
    for (const avgHR of [165, 168, 180]) {
      const r = computePredictionInputs([fast(avgHR), ...easy], NOW, FLOOR);
      const paceOnly = computePredictionInputs([fast(avgHR), ...easy], NOW);
      expect(r.paceRunsCounted).toBe(6);
      expect(r.avgPaceSecPerKm).toBe(paceOnly.avgPaceSecPerKm);
    }
    // One weekly 8 km tempo at 4:50/km among easy runs at 6:00/km: P is the easy pace.
    const weeks: RunActivityInput[] = [];
    for (let k = 0; k < 4; k++) {
      weeks.push({ ...run(1 + 7 * k, 8, 290), avgHR: 168 }, { ...run(3 + 7 * k, 10, 360), avgHR: 138 }, { ...run(5 + 7 * k, 8, 360), avgHR: 138 });
    }
    expect(computePredictionInputs(weeks, NOW, FLOOR).avgPaceSecPerKm).toBe(360);
  });

  it('the tempo at the HR §CY measured (168, 84% of reserve) is still a training run', () => {
    expect(computePredictionInputs([fast(168), ...easy], NOW, FLOOR).recentRun).toBeNull();
  });

  it('a hard tempo at the middle of Z4 (169) counts: at or above the floor', () => {
    expect(computePredictionInputs([fast(169), ...easy], NOW, FLOOR).recentRun).toMatchObject({ d: 5, t: 1425 });
  });

  it('a race at a race-level HR still counts', () => {
    const r = computePredictionInputs([fast(180), ...easy], NOW, FLOOR);
    expect(r.recentRun).toMatchObject({ d: 5, t: 1425, weeksAgo: 1 });
    expect(r.paceRunsCounted).toBe(6);
    // Exactly at the floor counts.
    expect(computePredictionInputs([fast(FLOOR), ...easy], NOW, FLOOR).recentRun).not.toBeNull();
  });

  it('a fast run without HR keeps the pace-only test', () => {
    const r = computePredictionInputs([fast(), ...easy.map(e => ({ ...e, avgHR: 140 }))], NOW, FLOOR);
    expect(r.recentRun).toMatchObject({ d: 5, t: 1425 });
  });

  it('requireHr (the triathlete evidence test): a fast run without HR does not count where HR zones exist', () => {
    const others = easy.map(e => ({ ...e, avgHR: 140 }));
    expect(computePredictionInputs([fast(), ...others], NOW, FLOOR, { requireHr: true }).recentRun).toBeNull();
    expect(computePredictionInputs([fast(180), ...others], NOW, FLOOR, { requireHr: true }).recentRun).toMatchObject({ d: 5, t: 1425 });
    expect(computePredictionInputs([fast(165), ...others], NOW, FLOOR, { requireHr: true }).recentRun).toBeNull();
    // No HR zones: no HR rules, so the pace test stands alone.
    expect(computePredictionInputs([fast(), ...others], NOW, null, { requireHr: true }).recentRun).toMatchObject({ d: 5, t: 1425 });
    // P never changes.
    expect(computePredictionInputs([fast(), ...others], NOW, FLOOR, { requireHr: true }).avgPaceSecPerKm)
      .toBe(computePredictionInputs([fast(), ...others], NOW, FLOOR).avgPaceSecPerKm);
  });

  it('without HR zones the test is pace-only even when the run has HR', () => {
    expect(computePredictionInputs([fast(165), ...easy], NOW, null).recentRun).toMatchObject({ d: 5, t: 1425 });
  });

  it('a 10K race at HR 174 counts (review 2); a half at 168 is a KNOWN FALSE NEGATIVE', () => {
    // Four weeks of easy runs at 6:30/km and HR 138, then a 10K race in 44:00
    // at HR 174 (91.6% of max HR, 89% of reserve). The 2026-10-09 floor (top
    // of Z4, 176) read it as a threshold effort; the midpoint (169) counts it.
    const jogs: RunActivityInput[] = [];
    for (let k = 0; k < 4; k++) jogs.push({ ...run(2 + 7 * k, 10, 390), avgHR: 138 }, { ...run(5 + 7 * k, 8, 390), avgHR: 138 });
    const race = { ...run(1, 10, 264), avgHR: 174 };
    const withHr = computePredictionInputs([race, ...jogs], NOW, FLOOR);
    expect(withHr.recentRun).toMatchObject({ d: 10, t: 2640 });
    // P stays the easy pace either way (pace-filtered).
    expect(withHr.avgPaceSecPerKm).toBe(390);
    expect(computePredictionInputs([race, ...jogs], NOW).avgPaceSecPerKm).toBe(390);
    // KNOWN FALSE NEGATIVE: a half marathon in 1:38 at HR 168 (84% of reserve,
    // the lower half of Z4) is not a race. It stays out of P (pace-filtered).
    const half = { ...run(1, 21.0975, 5880 / 21.0975), avgHR: 168 };
    const halfHr = computePredictionInputs([half, ...jogs], NOW, FLOOR);
    expect(halfHr.recentRun).toBeNull();
    expect(halfHr.avgPaceSecPerKm).toBe(390);
    expect(computePredictionInputs([half, ...jogs], NOW).recentRun).toMatchObject({ d: 21.0975 });
  });

  it('a slow run with a high HR is not a race (the pace test still applies)', () => {
    const hot = { ...run(3, 10, 350), avgHR: 182 };
    expect(computePredictionInputs([hot, ...easy], NOW, FLOOR).recentRun).toBeNull();
  });
});

describe('resolveWeeklyKmSignal', () => {
  const NOW = new Date('2026-04-15T12:00:00Z');

  it('history coverage wins — typed volume is ignored when the window has runs', () => {
    const inputs = computePredictionInputs(
      [run(1, 10, 300), run(3, 10, 300), run(8, 10, 300)], NOW,
    );
    expect(inputs.weeksCovered).toBeGreaterThan(0);
    // Typed 50 must not override measured history.
    expect(resolveWeeklyKmSignal(inputs, 50)).toBe(inputs.weeklyKm);
  });

  it('empty scrape falls back to the typed manual-entry volume', () => {
    const inputs = computePredictionInputs([], NOW);
    expect(resolveWeeklyKmSignal(inputs, 10)).toBe(10);
  });

  it('empty scrape with no typed volume stays an explicit zero (blend contract)', () => {
    const inputs = computePredictionInputs([], NOW);
    expect(resolveWeeklyKmSignal(inputs, undefined)).toBe(0);
    expect(resolveWeeklyKmSignal(inputs, null)).toBe(0);
    // 0 typed volume is not a usable signal either.
    expect(resolveWeeklyKmSignal(inputs, 0)).toBe(0);
  });
});
