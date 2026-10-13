import { describe, expect, it } from 'vitest';
import { computeStationPotential } from './hyrox-station-potential';
import { STATION_SEED_TIMES_SEC, stationSeedTimesFor } from '@/constants/hyrox-benchmarks';
import { doublesStationTeamSec, HYROX_DEFAULT_DOUBLES_TABLES } from './hyrox-doubles';
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

  const INT = STATION_SEED_TIMES_SEC.intermediate;
  const ADV = STATION_SEED_TIMES_SEC.advanced;

  it('uses next-band-up seed as the target', () => {
    // Intermediate user; next band = advanced (real band medians, lane H3b).
    const r = computeStationPotential('intermediate', [
      calibratedLine('ski_erg', INT.ski_erg),  // exactly the intermediate seed
    ]);
    expect(r.stations[0].targetBand).toBe('advanced');
    expect(r.stations[0].targetSec).toBe(ADV.ski_erg);
    expect(r.stations[0].savingSec).toBe(INT.ski_erg - ADV.ski_erg);
  });

  it('top targets sorted descending by savings', () => {
    const r = computeStationPotential('intermediate', [
      calibratedLine('ski_erg', ADV.ski_erg + 10),
      calibratedLine('sled_push', ADV.sled_push + 40),
      calibratedLine('wall_balls', ADV.wall_balls + 100),
    ]);
    expect(r.topTargets).toHaveLength(3);
    expect(r.topTargets[0].station).toBe('wall_balls');
    expect(r.topTargets[1].station).toBe('sled_push');
    expect(r.topTargets[2].station).toBe('ski_erg');
  });

  it('flags alreadyAhead when user is faster than next-band seed', () => {
    const r = computeStationPotential('intermediate', [
      calibratedLine('sled_push', ADV.sled_push - 10),
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
      calibratedLine('ski_erg', ADV.ski_erg + 20),
      calibratedLine('sled_push', ADV.sled_push + 45),
      calibratedLine('wall_balls', ADV.wall_balls + 100),
      calibratedLine('row_erg', ADV.row_erg + 30),
    ]);
    expect(r.totalSavingSec).toBe(20 + 45 + 100 + 30);
  });

  it('reads the seed cohort it is given (a Pro target reads Pro Singles band medians)', () => {
    const pro = stationSeedTimesFor('advanced', 'pro_singles', 'female');
    const r = computeStationPotential('intermediate', [calibratedLine('sled_push', pro.sled_push + 30)], { seedFormat: 'pro_singles', seedSex: 'female' });
    expect(r.stations[0].targetSec).toBe(pro.sled_push);
  });

  it('doubles: a pair-time line is compared with the seed scaled by the same doubles ratio', () => {
    // Without the scaling every doubles station read as already past target.
    const line: HyroxStationLine = { station: 'ski_erg', baseSec: INT.ski_erg * 0.9, adjustedSec: INT.ski_erg * 0.9, source: 'calibrated', teamRatio: 0.9 };
    const r = computeStationPotential('intermediate', [line]);
    expect(r.stations[0].targetSec).toBe(Math.round(ADV.ski_erg * 0.9));
    expect(r.stations[0].alreadyAhead).toBe(false);
    expect(r.stations[0].savingSec).toBe(Math.round(INT.ski_erg * 0.9 - Math.round(ADV.ski_erg * 0.9)));
  });

  it('doubles with the athlete\'s tables: the target maps to a pair\'s time per station', () => {
    const line: HyroxStationLine = { station: 'wall_balls', baseSec: 400, adjustedSec: 400, source: 'calibrated', teamRatio: 0.7 };
    const r = computeStationPotential('intermediate', [line], { doublesTables: HYROX_DEFAULT_DOUBLES_TABLES });
    expect(r.stations[0].targetSec).toBe(Math.round(doublesStationTeamSec('wall_balls', ADV.wall_balls)));
  });
});
