import { describe, expect, it } from 'vitest';
import {
  HYROX_PEER_SEGMENTS,
  hyroxCompetitiveFloors,
  hyroxPeerSplitsAt,
  hyroxRunLegShares,
  hyroxResultsTable,
  secondsAtPercentileIn,
  type HyroxResultsCohort,
} from './hyrox-results';
import { HYROX_S89_BAND_SEEDS, HYROX_S79_RUN_LEG_MEDIANS_SEC } from '@/data/hyrox-results-s79';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';

const OS_W: HyroxResultsCohort = { format: 'open_singles', sex: 'female' };
const OS_M: HyroxResultsCohort = { format: 'open_singles', sex: 'male' };
const OD_X: HyroxResultsCohort = { format: 'open_doubles', sex: 'mixed' };
const PS_M: HyroxResultsCohort = { format: 'pro_singles', sex: 'male' };

const sumSegments = (seg: Record<string, number>) => HYROX_PEER_SEGMENTS.reduce((a, k) => a + seg[k], 0);

describe('hyroxPeerSplitsAt: finishers at the same finish time', () => {
  it('the segments sum to the finish time', () => {
    for (const cohort of [OS_W, OS_M, OD_X, PS_M]) {
      for (const t of [3300, 4200, 5400, 6600, 9000]) {
        const p = hyroxPeerSplitsAt(cohort, t)!;
        expect(sumSegments(p.segments)).toBeCloseTo(t, 6);
        expect(p.runLegsSec.reduce((a, b) => a + b, 0)).toBeCloseTo(p.segments.run_total, 6);
      }
    }
  });

  it('at a band\'s own median finish the split mix is that band\'s real medians', () => {
    const cell = HYROX_S89_BAND_SEEDS.open_singles.female!.intermediate!;
    const p = hyroxPeerSplitsAt(OS_W, cell.medians.total)!;
    const rawSum = HYROX_PEER_SEGMENTS.reduce((a, k) => a + cell.medians[k], 0);
    const k = cell.medians.total / rawSum;
    for (const seg of HYROX_PEER_SEGMENTS) expect(p.segments[seg]).toBeCloseTo(cell.medians[seg] * k, 6);
    // The medians fall short of the median finish by under 1.3%.
    expect(Math.abs(k - 1)).toBeLessThan(0.013);
  });

  it('agrees with each table\'s median at the median finish (within 2.5% a segment)', () => {
    for (const cohort of [OS_W, OS_M, OD_X, PS_M]) {
      const total = hyroxResultsTable('total', cohort)!;
      const p = hyroxPeerSplitsAt(cohort, secondsAtPercentileIn(total, 50))!;
      for (const seg of HYROX_PEER_SEGMENTS) {
        const median = secondsAtPercentileIn(hyroxResultsTable(seg, cohort)!, 50);
        // The scaling to the finish lifts every segment about 1% over its own
        // median (medians are not additive); the shape matches.
        expect(Math.abs(p.segments[seg] - median) / median).toBeLessThan(0.025);
      }
    }
  });

  it('a faster finish has faster splits in every segment', () => {
    const fast = hyroxPeerSplitsAt(OS_M, 4500)!;
    const slow = hyroxPeerSplitsAt(OS_M, 6000)!;
    for (const seg of HYROX_PEER_SEGMENTS) expect(fast.segments[seg]).toBeLessThan(slow.segments[seg]);
  });

  it('past the fastest band keeps its split mix, scaled to the finish', () => {
    const top = HYROX_S89_BAND_SEEDS.open_singles.male!.competitive!.medians;
    const p = hyroxPeerSplitsAt(OS_M, top.total - 200)!;
    expect(p.position).toBe('faster');
    const rawSum = HYROX_PEER_SEGMENTS.reduce((a, k) => a + top[k], 0);
    expect(p.segments.wall_balls / p.segments.ski_erg).toBeCloseTo(top.wall_balls / top.ski_erg, 6);
    expect(sumSegments(p.segments)).toBeCloseTo(top.total - 200, 6);
    expect(rawSum).toBeGreaterThan(0);
  });

  it('Roxzone scales with the finish time (the data does not hold it constant)', () => {
    const a = hyroxPeerSplitsAt(OS_W, 4800)!.segments.roxzone;
    const b = hyroxPeerSplitsAt(OS_W, 7200)!.segments.roxzone;
    expect(b / a).toBeGreaterThan(1.4);
  });

  it('rejects a missing finish', () => {
    expect(hyroxPeerSplitsAt(OS_W, 0)).toBeNull();
    expect(hyroxPeerSplitsAt(OS_W, NaN)).toBeNull();
  });
});

describe('hyroxRunLegShares', () => {
  it('reads the cohort\'s own median legs: run 1 fastest, run 8 slowest', () => {
    const shares = hyroxRunLegShares(OS_W);
    const legs = HYROX_S79_RUN_LEG_MEDIANS_SEC.open_singles.female!;
    const sum = legs.reduce((a, b) => a + b, 0);
    shares.forEach((s, i) => expect(s).toBeCloseTo(legs[i] / sum, 9));
    expect(shares.indexOf(Math.min(...shares))).toBe(0);
    expect(shares.indexOf(Math.max(...shares))).toBe(7);
  });

  it('a pooled cohort averages the published sex cells', () => {
    const shares = hyroxRunLegShares({ format: 'open_singles', sex: 'pooled' });
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const w = hyroxRunLegShares(OS_W);
    const m = hyroxRunLegShares(OS_M);
    shares.forEach((s, i) => expect(s).toBeCloseTo((w[i] + m[i]) / 2, 9));
  });
});

describe('hyroxCompetitiveFloors: per format and sex or division', () => {
  it('reads the cohort\'s own top-1% band medians', () => {
    const w = hyroxCompetitiveFloors(OS_W)!;
    const m = hyroxCompetitiveFloors(OS_M)!;
    const cellW = HYROX_S89_BAND_SEEDS.open_singles.female!.competitive!.medians;
    for (const st of HYROX_STATION_ORDER) expect(w.stationSec[st]).toBe(cellW[st]);
    expect(w.runSec).toBe(cellW.run_total);
    expect(w.roxzoneSec).toBe(cellW.roxzone);
    // Women and men differ (the pooled seed the old floor used was neither).
    expect(w.stationSec.sled_push).not.toBe(m.stationSec.sled_push);
  });

  it('doubles floors are the pair\'s times in the division', () => {
    const x = hyroxCompetitiveFloors(OD_X)!;
    expect(x.stationSec.wall_balls).toBe(HYROX_S89_BAND_SEEDS.open_doubles.mixed!.competitive!.medians.wall_balls);
  });

  it('Pro Mixed does not exist: the pooled Pro Doubles cell stands in', () => {
    const f = hyroxCompetitiveFloors({ format: 'pro_doubles', sex: 'mixed' })!;
    expect(f.runSec).toBe(HYROX_S89_BAND_SEEDS.pro_doubles.pooled!.competitive!.medians.run_total);
  });
});
