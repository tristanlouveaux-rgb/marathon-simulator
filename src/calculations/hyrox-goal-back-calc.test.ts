import { describe, expect, it } from 'vitest';
import { computeGoalBackCalc } from './hyrox-goal-back-calc';
import type { HyroxPrediction, HyroxStationLine } from './race-prediction.hyrox';
import { STATION_SEED_TIMES_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';

function buildStations(overrides: Partial<Record<string, number>> = {}): HyroxStationLine[] {
  // Use intermediate seed times as defaults.
  const intermediate = STATION_SEED_TIMES_SEC.intermediate;
  return Object.entries(intermediate).map(([station, sec]) => ({
    station: station as never,
    baseSec: overrides[station] ?? sec,
    adjustedSec: overrides[station] ?? sec,
    source: 'calibrated' as const,
  }));
}

function buildPrediction(opts: {
  runSec?: number;
  stations?: HyroxStationLine[];
  roxzoneSec?: number;
} = {}): HyroxPrediction {
  const stations = opts.stations ?? buildStations();
  const runSec = opts.runSec ?? 2440; // 8 × 305 sec/km (intermediate)
  const roxzoneSec = opts.roxzoneSec ?? 200;
  const stationsSec = stations.reduce((sum, l) => sum + l.adjustedSec, 0);
  const totalSec = runSec + stationsSec + roxzoneSec;
  return {
    totalSec,
    runSec,
    stationsSec,
    roxzoneSec,
    rawSec: totalSec,
    stations,
    runLegs: [],
    courseFactors: [],
    computedAtISO: new Date().toISOString(),
    confidence: 'medium',
    calibratedCount: 8,
    runPaceSource: 'user',
  } as HyroxPrediction;
}

describe('computeGoalBackCalc', () => {
  it('target slower than current → already_on_pace, no targets need to change', () => {
    const p = buildPrediction(); // intermediate ~ 4884s
    const r = computeGoalBackCalc(p, p.totalSec + 300);
    expect(r.feasibility).toBe('already_on_pace');
    expect(r.gainNeededSec).toBe(0);
    expect(r.stationTargets.every(t => t.deltaSec === 0)).toBe(true);
    expect(r.runPaceTarget.deltaSecKm).toBe(0);
  });

  it('small achievable gain distributes across stations + run pace', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec - 100);
    expect(r.feasibility).toBe('achievable');
    expect(r.gainNeededSec).toBe(100);
    // Sum of allocated deltas should equal the gain.
    const totalAllocated = -r.runPaceTarget.deltaSecKm * 8
      + -r.stationTargets.reduce((sum, t) => sum + t.deltaSec, 0);
    expect(totalAllocated).toBeCloseTo(100, 0);
  });

  it('every component receives some allocation when all have headroom', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec - 100);
    expect(r.stationTargets.every(t => t.deltaSec < 0)).toBe(true);
    expect(r.runPaceTarget.deltaSecKm).toBeLessThan(0);
  });

  it('component already at floor gets zero allocation', () => {
    const stations = buildStations({
      ski_erg: STATION_SEED_TIMES_SEC.competitive.ski_erg,
    });
    const p = buildPrediction({ stations });
    const r = computeGoalBackCalc(p, p.totalSec - 100);
    const skiTarget = r.stationTargets.find(t => t.station === 'ski_erg')!;
    expect(skiTarget.deltaSec).toBeCloseTo(0, 0);
  });

  it('unrealistic target → flagged with shortfall and caveat', () => {
    const p = buildPrediction();
    // Target 30 min from a ~80 min current — far beyond population floor across all stations.
    const r = computeGoalBackCalc(p, 1800);
    expect(r.feasibility).toBe('unrealistic');
    expect(r.shortfallSec).toBeGreaterThan(0);
    expect(r.caveat).not.toBeNull();
  });

  it('stretch goal flagged when gain > 70% of total headroom', () => {
    const p = buildPrediction();
    // First, get the total headroom to make a defensible test target.
    const easyTarget = computeGoalBackCalc(p, p.totalSec - 50);
    const headroom = easyTarget.totalHeadroomSec;
    // Pick a target that demands 75% of headroom.
    const stretchTarget = p.totalSec - Math.round(headroom * 0.75);
    const r = computeGoalBackCalc(p, stretchTarget);
    expect(r.feasibility).toBe('stretch');
    expect(r.caveat).not.toBeNull();
  });

  it('achievedSec sums to targetTotalSec for achievable targets', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec - 100);
    expect(r.achievedSec).toBeCloseTo(p.totalSec - 100, 0);
  });

  it('run pace floor respected (HYROX_RUN_PACE_MIN_SEC_KM × 8)', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec - 100);
    expect(r.runPaceTarget.targetSecKm).toBeGreaterThanOrEqual(HYROX_RUN_PACE_MIN_SEC_KM);
  });
});
