import { describe, expect, it } from 'vitest';
import { computeStationPotential } from './hyrox-station-potential';
import { STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import type { HyroxStationLine } from './race-prediction.hyrox';

function calibratedLine(station: keyof typeof STATION_SEED_TIMES_SEC['intermediate'], baseSec: number): HyroxStationLine {
  return { station, baseSec, adjustedSec: baseSec, source: 'calibrated' };
}

function seedLine(station: keyof typeof STATION_SEED_TIMES_SEC['intermediate']): HyroxStationLine {
  const seed = STATION_SEED_TIMES_SEC.intermediate[station];
  return { station, baseSec: seed, adjustedSec: seed, source: 'seed' };
}

describe('computeStationPotential', () => {
  it('returns no targets when no stations are calibrated', () => {
    const result = computeStationPotential('intermediate', [
      seedLine('ski_erg'), seedLine('sled_push'),
    ]);
    expect(result.stations).toHaveLength(0);
    expect(result.topTargets).toHaveLength(0);
    expect(result.totalSavingSec).toBe(0);
  });

  it('uses next-band-up seed as the target', () => {
    // Intermediate user; next band = advanced.
    // Intermediate seed for ski_erg = 267, advanced = 260.
    const r = computeStationPotential('intermediate', [
      calibratedLine('ski_erg', 267),  // exactly intermediate seed
    ]);
    expect(r.stations[0].targetBand).toBe('advanced');
    expect(r.stations[0].targetSec).toBe(260);
    expect(r.stations[0].savingSec).toBe(7);
  });

  it('top targets sorted descending by savings', () => {
    // Intermediate user. Ski_erg current 280 (target 260, save 20).
    // Sled_push current 235 (target 190, save 45).
    // Wall_balls current 415 (target 315, save 100).
    const r = computeStationPotential('intermediate', [
      calibratedLine('ski_erg', 280),
      calibratedLine('sled_push', 235),
      calibratedLine('wall_balls', 415),
    ]);
    expect(r.topTargets).toHaveLength(3);
    expect(r.topTargets[0].station).toBe('wall_balls');
    expect(r.topTargets[1].station).toBe('sled_push');
    expect(r.topTargets[2].station).toBe('ski_erg');
  });

  it('flags alreadyAhead when user is faster than next-band seed', () => {
    // Intermediate user with a sled_push at 180 (faster than advanced seed 190).
    const r = computeStationPotential('intermediate', [
      calibratedLine('sled_push', 180),
    ]);
    expect(r.stations[0].alreadyAhead).toBe(true);
    expect(r.stations[0].savingSec).toBe(0);
    expect(r.topTargets).toHaveLength(0); // alreadyAhead excluded
  });

  it('caps target at competitive band for elite users', () => {
    // competitive user → next band stays competitive (clamp).
    const r = computeStationPotential('competitive', [
      calibratedLine('ski_erg', 230),
    ]);
    expect(r.stations[0].targetBand).toBe('competitive');
  });

  it('totalSavingSec sums all calibrated stations (including non-top-3)', () => {
    const r = computeStationPotential('intermediate', [
      calibratedLine('ski_erg', 280),       // save 20
      calibratedLine('sled_push', 235),     // save 45
      calibratedLine('wall_balls', 415),    // save 100
      calibratedLine('row_erg', 290),       // save 30
    ]);
    expect(r.totalSavingSec).toBe(20 + 45 + 100 + 30);
  });
});
