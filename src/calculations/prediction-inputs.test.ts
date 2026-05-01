import { describe, it, expect } from 'vitest';
import { computePredictionInputs, type RunActivityInput } from './prediction-inputs';

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
      run(1, 5, 500),     // 8:20/km walk — filtered
      run(2, 5, 150),     // 2:30/km sprint — filtered
      run(3, 5, 300),     // 5:00/km — kept
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
      run(1, 21, 240),  // race: 21km at 4:00/km — 20% faster than median
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
    // 50 km across 2 weeks = ~25 km/wk. With 8-week div would be ~6 — bug.
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
      run(11, 8, 450), // slowest tail — in band but should be dropped
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(9);
    // Average pace should reflect only the fast runs, not be pulled by 450
    expect(r.avgPaceSecPerKm).toBeCloseTo(270, 0);
  });

  it('skips slow-tail drop when fewer than 5 runs remain', () => {
    // 4 runs — sample too small to safely trim.
    const runs: RunActivityInput[] = [
      run(1, 8, 270), run(3, 8, 270), run(5, 8, 270), run(7, 8, 450),
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(4);
  });

  it('rejects runs shorter than 3 km', () => {
    const runs = [
      run(1, 2.5, 300),     // too short under new threshold
      run(2, 3.0, 300),     // exact threshold — kept
      run(3, 5, 300),
      run(4, 5, 300),
    ];
    const r = computePredictionInputs(runs, NOW);
    expect(r.runsCounted).toBe(3);
  });

  it('populates recentRun with newest qualifying activity', () => {
    const runs = [run(5, 10, 300), run(10, 8, 320), run(15, 8, 320)];
    const r = computePredictionInputs(runs, NOW);
    expect(r.recentRun).not.toBeNull();
    expect(r.recentRun!.d).toBe(10);
    expect(r.recentRun!.weeksAgo).toBeLessThanOrEqual(1);
  });
});
