import { describe, expect, it } from 'vitest';
import {
  HYROX_PEER_SEGMENTS,
  hyroxCompetitiveFloors,
  hyroxPeerResidualWeights,
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

  it('at a band\'s own median finish: the band\'s real medians plus the gap spread by skew', () => {
    const cell = HYROX_S89_BAND_SEEDS.open_singles.female!.intermediate!;
    const p = hyroxPeerSplitsAt(OS_W, cell.medians.total)!;
    const rawSum = HYROX_PEER_SEGMENTS.reduce((a, k) => a + cell.medians[k], 0);
    const gap = cell.medians.total - rawSum;
    const w = hyroxPeerResidualWeights(OS_W)!;
    for (const seg of HYROX_PEER_SEGMENTS) expect(p.segments[seg]).toBeCloseTo(cell.medians[seg] + gap * w[seg], 6);
    // The medians fall short of the median finish by under 1.3%.
    expect(Math.abs(gap) / cell.medians.total).toBeLessThan(0.013);
  });

  it('agrees with each table\'s median at the median finish (within 2.5% a segment)', () => {
    for (const cohort of [OS_W, OS_M, OD_X, PS_M]) {
      const total = hyroxResultsTable('total', cohort)!;
      const p = hyroxPeerSplitsAt(cohort, secondsAtPercentileIn(total, 50))!;
      for (const seg of HYROX_PEER_SEGMENTS) {
        const median = secondsAtPercentileIn(hyroxResultsTable(seg, cohort)!, 50);
        // The medians' gap lifts the skewed segments a little over their own
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

  it('past the fastest band keeps its split mix, scaled to the finish, plus the gap by skew', () => {
    const top = HYROX_S89_BAND_SEEDS.open_singles.male!.competitive!.medians;
    const t = top.total - 200;
    const p = hyroxPeerSplitsAt(OS_M, t)!;
    expect(p.position).toBe('faster');
    const k = t / top.total;
    const rawSum = HYROX_PEER_SEGMENTS.reduce((a, s) => a + top[s] * k, 0);
    const w = hyroxPeerResidualWeights(OS_M)!;
    for (const seg of HYROX_PEER_SEGMENTS) expect(p.segments[seg]).toBeCloseTo(top[seg] * k + (t - rawSum) * w[seg], 6);
    expect(sumSegments(p.segments)).toBeCloseTo(t, 6);
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

const ALL_COHORTS: HyroxResultsCohort[] = [
  OS_W, OS_M,
  { format: 'pro_singles', sex: 'female' }, PS_M,
  { format: 'open_doubles', sex: 'female' }, { format: 'open_doubles', sex: 'male' }, OD_X,
  { format: 'pro_doubles', sex: 'female' }, { format: 'pro_doubles', sex: 'male' },
  { format: 'open_singles', sex: 'pooled' }, { format: 'pro_singles', sex: 'pooled' },
  { format: 'open_doubles', sex: 'pooled' }, { format: 'pro_doubles', sex: 'pooled' },
];
const BANDS = ['competitive', 'advanced', 'intermediate', 'novice', 'beginner'] as const;

describe('the medians\' additivity gap goes to the skewed segments (review 3)', () => {
  it('weights are each segment\'s Bowley skew from the cohort\'s own table, summing to 1', () => {
    for (const cohort of ALL_COHORTS) {
      const w = hyroxPeerResidualWeights(cohort)!;
      expect(HYROX_PEER_SEGMENTS.reduce((a, s) => a + w[s], 0)).toBeCloseTo(1, 9);
      const skew = (seg: string) => {
        const t = hyroxResultsTable(seg as never, cohort)!;
        const q = (pct: number) => secondsAtPercentileIn(t, pct);
        return Math.max(0, (q(75) - q(50)) - (q(50) - q(25)));
      };
      const total = HYROX_PEER_SEGMENTS.reduce((a, s) => a + skew(s), 0);
      for (const seg of HYROX_PEER_SEGMENTS) expect(w[seg]).toBeCloseTo(skew(seg) / total, 9);
    }
  });

  it('the run total takes its skew share, not half the gap: at every band\'s median finish in every cohort it is under 26 s and below the size-proportional share', () => {
    for (const cohort of ALL_COHORTS) {
      const cells = HYROX_S89_BAND_SEEDS[cohort.format][cohort.sex] ?? HYROX_S89_BAND_SEEDS[cohort.format].pooled!;
      for (const b of BANDS) {
        const m = cells[b]?.medians;
        if (!m) continue;
        const p = hyroxPeerSplitsAt(cohort, m.total)!;
        const rawSum = HYROX_PEER_SEGMENTS.reduce((a, s) => a + m[s], 0);
        const gap = m.total - rawSum;
        const runShare = p.segments.run_total - m.run_total;
        const proportional = gap * (m.run_total / rawSum);
        expect(Math.abs(runShare)).toBeLessThan(26);
        expect(Math.abs(runShare)).toBeLessThanOrEqual(Math.abs(proportional) + 1e-9);
      }
    }
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
