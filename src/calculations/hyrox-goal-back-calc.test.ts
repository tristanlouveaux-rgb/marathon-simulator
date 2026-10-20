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
    // Target 30 min from a ~80 min current. Far beyond population floor across all stations.
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

  it('doubles: station floors scale by the line\'s doubles ratio (pair\'s times)', () => {
    const ratio = 0.7;
    const stations = buildStations().map(l => ({
      ...l, baseSec: l.baseSec * ratio, adjustedSec: l.adjustedSec * ratio, teamRatio: ratio,
    }));
    const p = buildPrediction({ stations });
    const r = computeGoalBackCalc(p, p.totalSec - 600);
    for (const t of r.stationTargets) {
      expect(t.targetSec).toBeGreaterThanOrEqual(STATION_SEED_TIMES_SEC.competitive[t.station] * ratio - 0.5);
    }
    // Stations still contribute: the pair's times sit above the scaled floors.
    expect(r.stationTargets.some(t => t.deltaSec < 0)).toBe(true);
  });
});

describe('computeGoalBackCalc options: cohort floors and the Roxzone at the goal', () => {
  const floors = {
    stationSec: Object.fromEntries(Object.entries(STATION_SEED_TIMES_SEC.intermediate).map(([st, sec]) => [st, sec - 20])),
    runSec: 2440 - 160,
  };

  it('cohort floors cap every component; floorSource says so', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec - 5000, { floors });
    expect(r.floorSource).toBe('cohort');
    expect(r.feasibility).toBe('unrealistic');
    for (const t of r.stationTargets) expect(t.targetSec).toBeCloseTo(floors.stationSec[t.station]!, 6);
    expect(r.runPaceTarget.targetSecKm * 8).toBeCloseTo(floors.runSec, 6);
    expect(r.caveat).toContain('faster than top-1% level in your field');
    // Without options the legacy floors stand.
    expect(computeGoalBackCalc(p, p.totalSec - 100).floorSource).toBe('legacy');
  });

  it('one floor per component whatever the forecast: a component 1 s slower adds 1 s of headroom', () => {
    const stations = buildStations();
    const floorSec = Object.fromEntries(stations.map(l => [l.station, l.adjustedSec - 10])) as Record<string, number>;
    const floors = { stationSec: floorSec, runSec: 2440 - 40, roxzoneSec: 180 };
    const p = buildPrediction({ stations, roxzoneSec: 200 });
    const r = computeGoalBackCalc(p, p.totalSec - 60, { floors });
    expect(r.totalHeadroomSec).toBeCloseTo(80 + 40, 6);
    for (const delta of [-1, 1, 5]) {
      const q = buildPrediction({ stations: buildStations({ ski_erg: stations[0].adjustedSec + delta }), roxzoneSec: 200 });
      expect(stations[0].station).toBe('ski_erg');
      const r2 = computeGoalBackCalc(q, q.totalSec - 60, { floors });
      expect(r2.totalHeadroomSec - r.totalHeadroomSec).toBeCloseTo(delta, 6);
    }
    // Past the floor sum: unrealistic, achieved at the floor sum (stations
    // 80 s, run 40 s, and the Roxzone gives 20 s down to its floor).
    const out = computeGoalBackCalc(p, p.totalSec - 200, { floors });
    expect(out.feasibility).toBe('unrealistic');
    expect(out.achievedSec).toBeCloseTo(p.totalSec - 140, 6);
  });

  it('floors are venue-neutral: each carries the line\'s own venue seconds (headroom on the venue-neutral line)', () => {
    const neutral = buildStations();
    const stations = neutral.map(l => ({ ...l, adjustedSec: l.baseSec + (l.station === 'ski_erg' ? 16 : 0) }));
    const base = buildPrediction({ stations, runSec: 2440 });
    // A venue: the run is 40 s slower than its pre-venue time (rawSec holds
    // the pre-venue run + stations + Roxzone).
    const rawRun = 2400;
    const p = { ...base, rawSec: rawRun + neutral.reduce((a, l) => a + l.baseSec, 0) + base.roxzoneSec, courseFactors: [{ kind: 'altitude', label: 'Altitude', value: '2240 m', deltaSec: 56 }] } as HyroxPrediction;
    const floors = { stationSec: Object.fromEntries(neutral.map(l => [l.station, l.baseSec - 20])), runSec: rawRun - 160 };
    const r = computeGoalBackCalc(p, p.totalSec - 5000, { floors });
    expect(r.stationTargets.find(t => t.station === 'ski_erg')!.targetSec).toBeCloseTo(floors.stationSec.ski_erg! + 16, 6);
    expect(r.stationTargets.find(t => t.station === 'row_erg')!.targetSec).toBeCloseTo(floors.stationSec.row_erg!, 6);
    expect(r.runPaceTarget.targetSecKm * 8).toBeCloseTo(floors.runSec + 40, 6);
  });

  it('a Roxzone target takes its share of the gain; the rest is distributed', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec - 100, { roxzoneTargetSec: p.roxzoneSec - 10 });
    expect(r.roxzoneSec).toBe(p.roxzoneSec - 10);
    expect(r.gainNeededSec).toBeCloseTo(90, 6);
    expect(r.achievedSec).toBeCloseTo(p.totalSec - 100, 6);
  });

  it('the Roxzone never absorbs more than the whole gain', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec - 5, { roxzoneTargetSec: p.roxzoneSec - 50 });
    expect(r.roxzoneSec).toBe(p.roxzoneSec - 5);
    expect(r.gainNeededSec).toBe(0);
    expect(r.achievedSec).toBeCloseTo(p.totalSec - 5, 6);
  });

  it('a slower goal holds the Roxzone at the forecast\'s', () => {
    const p = buildPrediction();
    const r = computeGoalBackCalc(p, p.totalSec + 100, { roxzoneTargetSec: p.roxzoneSec + 30 });
    expect(r.feasibility).toBe('already_on_pace');
    expect(r.roxzoneSec).toBe(p.roxzoneSec);
  });

  it('the gain is measured from the lines, not a totalSec rounded apart from them', () => {
    // The forecast rounds the run and each line separately: here the lines
    // sum 1 s over totalSec. Measured from totalSec this read 'unrealistic'.
    const p = { ...buildPrediction(), totalSec: buildPrediction().totalSec - 1 };
    const r = computeGoalBackCalc(p, p.totalSec - 60);
    expect(r.feasibility).toBe('achievable');
    expect(r.shortfallSec).toBe(0);
    expect(r.achievedSec).toBeCloseTo(p.totalSec - 60, 6);
  });

  it('a Roxzone floor: the target never goes below it, held at the forecast\'s own when that is faster', () => {
    const p = buildPrediction({ roxzoneSec: 300 });
    const floors = { stationSec: {}, runSec: 0, roxzoneSec: 250 };
    const r = computeGoalBackCalc(p, p.totalSec - 200, { floors, roxzoneTargetSec: 200 });
    expect(r.roxzoneSec).toBe(250);
    // Forecast Roxzone already under the floor: held there.
    const q = buildPrediction({ roxzoneSec: 240 });
    const r2 = computeGoalBackCalc(q, q.totalSec - 200, { floors, roxzoneTargetSec: 200 });
    expect(r2.roxzoneSec).toBe(240);
  });

  it('every other component at its floor: the Roxzone gives up to its floor, so the fastest time is the floor sum', () => {
    const stations = buildStations();
    const stationSec = Object.fromEntries(stations.map(l => [l.station, l.adjustedSec])) as Record<string, number>;
    // Run and stations already at their floors; the Roxzone target sits
    // above the Roxzone floor.
    const p = buildPrediction({ stations, roxzoneSec: 300 });
    const floors = { stationSec, runSec: p.runSec, roxzoneSec: 250 };
    for (const goal of [p.totalSec - 200, p.totalSec - 400]) {
      const r = computeGoalBackCalc(p, goal, { floors, roxzoneTargetSec: 290 });
      expect(r.feasibility).toBe('unrealistic');
      expect(r.roxzoneSec).toBe(250);
      expect(r.achievedSec).toBeCloseTo(p.totalSec - 50, 6);
    }
    // 30 s faster: inside what the Roxzone can give, so a stretch.
    const r3 = computeGoalBackCalc(p, p.totalSec - 30, { floors, roxzoneTargetSec: 290 });
    expect(r3.feasibility).toBe('stretch');
    expect(r3.roxzoneSec).toBeCloseTo(270, 6);
    expect(r3.achievedSec).toBeCloseTo(p.totalSec - 30, 6);
  });
});
