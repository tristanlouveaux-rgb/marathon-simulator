import { describe, expect, it } from 'vitest';
import { parseHyroxActivity, applyParsedBenchmarks } from './hyrox-activity-parser';
import type { GarminLap } from '@/types/state';

function lap(index: number, distanceM: number, durationSec: number, paceSecKm: number, avgHR?: number): GarminLap {
  return { index, distanceM, durationSec, avgPaceSecKm: paceSecKm, avgHR };
}

/** Build a 16-lap synthetic HYROX activity: 8 × 1km runs + 8 × stations. */
function buildSyntheticHyroxLaps(): GarminLap[] {
  const out: GarminLap[] = [];
  let i = 0;
  for (let s = 0; s < 8; s++) {
    out.push(lap(++i, 1000, 270, 270, 165));   // 4:30/km run
    out.push(lap(++i, 60, 240, 4000, 175));    // 4 min station
  }
  return out;
}

describe('parseHyroxActivity', () => {
  it('returns isHyrox false when neither name nor structure match', () => {
    const r = parseHyroxActivity('Morning run', [lap(1, 5000, 1500, 300)]);
    expect(r.isHyrox).toBe(false);
    expect(r.detectionSource).toBe('none');
  });

  it('detects via name even without lap data', () => {
    const r = parseHyroxActivity('HYROX Vienna Sim', null);
    expect(r.isHyrox).toBe(true);
    expect(r.detectionSource).toBe('name');
    expect(r.legs).toHaveLength(0);
  });

  it('detects via structure when name is generic', () => {
    const r = parseHyroxActivity('Workout', buildSyntheticHyroxLaps());
    expect(r.isHyrox).toBe(true);
    expect(r.detectionSource).toBe('structure');
    expect(r.legs.length).toBe(16);
  });

  it('detects via both name + structure', () => {
    const r = parseHyroxActivity('HYROX', buildSyntheticHyroxLaps());
    expect(r.detectionSource).toBe('name+structure');
  });

  it('classifies 8 runs and 8 stations from synthetic structure', () => {
    const r = parseHyroxActivity('HYROX', buildSyntheticHyroxLaps());
    const runs = r.legs.filter(l => l.kind === 'run');
    const stations = r.legs.filter(l => l.kind === 'station');
    expect(runs.length).toBe(8);
    expect(stations.length).toBe(8);
  });

  it('produces runTotal aggregate', () => {
    const r = parseHyroxActivity('HYROX', buildSyntheticHyroxLaps());
    expect(r.runTotal).toBeDefined();
    expect(r.runTotal!.totalSec).toBe(8 * 270); // 8 × 1km @ 270s
    expect(r.runTotal!.meanPaceSecKm).toBe(270);
  });

  it('produces stationTimes when ≥ 4 stations identified', () => {
    const r = parseHyroxActivity('HYROX', buildSyntheticHyroxLaps());
    expect(r.stationTimes).toBeDefined();
    expect(Object.keys(r.stationTimes ?? {})).toHaveLength(8);
  });

  it('skips stationTimes when too few stations', () => {
    // 4 runs only, 0 stations → still tries 8 laps total: 4 unidentified
    const onlyRuns: GarminLap[] = [
      lap(1, 1000, 270, 270),
      lap(2, 1000, 270, 270),
      lap(3, 1000, 270, 270),
      lap(4, 1000, 270, 270),
    ];
    const r = parseHyroxActivity('HYROX', onlyRuns);
    expect(r.stationTimes).toBeUndefined();
  });
});

describe('applyParsedBenchmarks', () => {
  it('improves a benchmark when new time is faster (PB only)', () => {
    const current = { ski_erg: 270, sled_push: 200 };
    const parsed = parseHyroxActivity('HYROX', buildSyntheticHyroxLaps());
    // Synthetic stations are all 240s — so ski_erg (current 270) improves, sled_push (200) doesn't.
    const { updated, improvements } = applyParsedBenchmarks(current, parsed);
    expect(updated.ski_erg).toBe(240);
    expect(updated.sled_push).toBe(200);  // not overwritten with 240 (slower than 200)
    expect(improvements.ski_erg).toBe(30);
    expect(improvements.sled_push).toBeUndefined();
  });

  it('seeds benchmarks when none existed', () => {
    const parsed = parseHyroxActivity('HYROX', buildSyntheticHyroxLaps());
    const { updated } = applyParsedBenchmarks(undefined, parsed);
    expect(Object.keys(updated)).toHaveLength(8);
    expect(updated.ski_erg).toBe(240);
  });

  it('returns no-op when activity has no stationTimes', () => {
    const parsed = { isHyrox: true, detectionSource: 'name' as const, legs: [] };
    const { updated, improvements } = applyParsedBenchmarks({ ski_erg: 250 }, parsed);
    expect(updated.ski_erg).toBe(250);
    expect(improvements).toEqual({});
  });
});
