/**
 * Guards for the generated HYROX S7-S9 results module.
 *
 * These check the tables against their own provenance (the ingest report and
 * cell counts written by scripts/ingest-hyrox-results-s79.py), the DKW
 * cell-size rule, the app's band thresholds, and three medians quoted by the
 * lane brief as a smoke check.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HYROX_TIME_TO_BAND_THRESHOLDS } from '@/constants/hyrox-constants';
import {
  HYROX_S79_AGE_DROPS,
  HYROX_S79_AGE_GROUPS,
  HYROX_S79_AGE_SUPPRESSED_CELLS,
  HYROX_S79_AGE_TOTAL_COUNTS,
  HYROX_S79_AGE_TOTAL_PERCENTILES,
  HYROX_S79_ATTRIBUTION,
  HYROX_S79_CROSS_LABEL_RESOLUTIONS,
  HYROX_S79_DKW_ALPHA,
  HYROX_S79_FINISHER_COUNTS,
  HYROX_S79_GRIDS,
  HYROX_S79_GRID_LADDER,
  HYROX_S79_IMPROVEMENT,
  HYROX_S79_IMPROVEMENT_BAND_THRESHOLDS,
  HYROX_S79_IMPROVEMENT_REPORT,
  HYROX_S79_IMPROVEMENT_SUPPRESSED,
  HYROX_S79_INGEST_REPORT,
  HYROX_S79_LAST_REFRESH_DATE,
  HYROX_S79_MIN_CELL_N,
  HYROX_S79_PERCENTILES,
  HYROX_S79_RUN_LEG_MEDIANS_SEC,
  HYROX_S79_SAME_VENUE_SEASON_SHIFT,
  HYROX_S79_SEASONS,
  HYROX_S79_SEASON_MEDIANS,
  HYROX_S79_SUPPRESSED_CELLS,
  HYROX_S79_TOTAL_FENCES_SEC,
  HYROX_S79_VENUE_SPREAD,
  HYROX_S89_FINISHER_COUNTS,
  HYROX_S89_GRIDS,
  HYROX_S89_PERCENTILES,
  HYROX_S89_SEASONS,
  HYROX_S89_SUPPRESSED_CELLS,
  type HyroxPercentileTable,
  type HyroxResultsFormat,
  type HyroxResultsMetric,
  type HyroxResultsSex,
} from './hyrox-results-s79';

const FORMATS: HyroxResultsFormat[] = ['open_singles', 'pro_singles', 'open_doubles', 'pro_doubles'];
const SEXES: HyroxResultsSex[] = ['female', 'male', 'mixed'];
const METRICS: HyroxResultsMetric[] = [
  'total', 'run_total', 'work_total', 'roxzone',
  'ski_erg', 'sled_push', 'sled_pull', 'burpee_broad_jumps',
  'row_erg', 'farmer_carry', 'sandbag_lunges', 'wall_balls',
];
const SPLIT_METRICS = METRICS.filter(m => m !== 'total' && m !== 'roxzone');

/** DKW 95% simultaneous band half-width (Massart constant). */
const dkwEps = (n: number) => Math.sqrt(Math.log(2 / HYROX_S79_DKW_ALPHA) / (2 * n));
const minGap = (ps: readonly number[]) => Math.min(...ps.slice(1).map((p, i) => p - ps[i]));
const finestGridFor = (n: number) => HYROX_S79_GRID_LADDER.find(g => n >= g.minN) ?? null;
const at = (t: HyroxPercentileTable, p: number) => t.find(([, q]) => q === p)?.[0];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

type CellFamily = {
  percentiles: typeof HYROX_S79_PERCENTILES;
  counts: typeof HYROX_S79_FINISHER_COUNTS;
};
const POOLED: CellFamily = { percentiles: HYROX_S79_PERCENTILES, counts: HYROX_S79_FINISHER_COUNTS };
const CURRENT_JUDGING: CellFamily = { percentiles: HYROX_S89_PERCENTILES, counts: HYROX_S89_FINISHER_COUNTS };

interface MainCell { format: HyroxResultsFormat; sex: HyroxResultsSex; metric: HyroxResultsMetric; table: HyroxPercentileTable; n: number }
function mainCells(family: CellFamily = POOLED): MainCell[] {
  const out: MainCell[] = [];
  for (const format of FORMATS) {
    for (const sex of SEXES) {
      const byMetric = family.percentiles[format][sex];
      if (!byMetric) continue;
      for (const metric of METRICS) {
        out.push({ format, sex, metric, table: byMetric[metric], n: family.counts[format][sex]![metric] });
      }
    }
  }
  return out;
}

interface AgeCell { format: HyroxResultsFormat; sex: HyroxResultsSex; band: string; table: HyroxPercentileTable; n: number }
function ageCells(): AgeCell[] {
  const out: AgeCell[] = [];
  for (const format of FORMATS) {
    for (const sex of SEXES) {
      const byBand = HYROX_S79_AGE_TOTAL_PERCENTILES[format][sex];
      if (!byBand) continue;
      for (const [band, table] of Object.entries(byBand)) {
        out.push({ format, sex, band, table, n: HYROX_S79_AGE_TOTAL_COUNTS[format][sex]![band] });
      }
    }
  }
  return out;
}

function expectWellFormed(table: HyroxPercentileTable, n: number, label: string) {
  expect(table.length, label).toBeGreaterThan(0);
  for (let i = 0; i < table.length; i++) {
    const [sec, p] = table[i];
    expect(Number.isInteger(sec) && sec > 0, `${label} seconds`).toBe(true);
    expect(p > 0 && p < 100, `${label} percentile`).toBe(true);
    if (i > 0) {
      expect(sec, `${label} seconds strictly increasing at p${p}`).toBeGreaterThan(table[i - 1][0]);
      expect(p, `${label} percentiles strictly increasing`).toBeGreaterThan(table[i - 1][1]);
    }
  }
  // The table sits on exactly the finest ladder grid its n supports, and that
  // grid's neighbouring breakpoints are resolved by the DKW band.
  const grid = finestGridFor(n);
  expect(grid, `${label} n=${n} must meet the minimum`).not.toBeNull();
  expect(table.map(([, p]) => p), label).toEqual([...grid!.percentiles]);
  expect(2 * dkwEps(n) * 100, `${label} DKW resolution`).toBeLessThanOrEqual(minGap(grid!.percentiles));
}

describe('HYROX S7-S9 results: provenance', () => {
  it('carries the agreed attribution, seasons and refresh date', () => {
    expect(HYROX_S79_ATTRIBUTION).toBe('HYROX results, seasons 7 to 9 (2024 to 2026), via the open pyrox project');
    expect([...HYROX_S79_SEASONS]).toEqual([7, 8, 9]);
    expect(HYROX_S79_LAST_REFRESH_DATE).toBe('2026-10-13');
  });

  it('stays well under the 400 KB budget', () => {
    const file = path.resolve(__dirname, 'hyrox-results-s79.ts');
    expect(fs.statSync(file).size).toBeLessThan(400 * 1024);
  });
});

describe('HYROX S7-S9 results: cell-size rule', () => {
  it('derives every ladder minN from the DKW inequality', () => {
    for (const g of HYROX_S79_GRID_LADDER) {
      const gap = minGap(g.percentiles) / 100;
      // minN is the smallest n with 2*eps(n) <= smallest gap.
      expect(2 * dkwEps(g.minN)).toBeLessThanOrEqual(gap + 1e-12);
      expect(2 * dkwEps(g.minN - 1)).toBeGreaterThan(gap);
    }
    const ns = HYROX_S79_GRID_LADDER.map(g => g.minN);
    expect(ns).toEqual([...ns].sort((a, b) => b - a));
    expect(HYROX_S79_MIN_CELL_N).toBe(ns[ns.length - 1]);
  });
});

describe('HYROX S7-S9 results: percentile tables', () => {
  it('publishes every metric for each published format x sex, and nothing for suppressed cells', () => {
    for (const format of FORMATS) {
      for (const sex of SEXES) {
        const published = HYROX_S79_PERCENTILES[format][sex];
        const suppressed = HYROX_S79_SUPPRESSED_CELLS.find(c => c.format === format && c.sex === sex);
        if (published) {
          expect(suppressed).toBeUndefined();
          expect(Object.keys(published).sort()).toEqual([...METRICS].sort());
        }
        if (suppressed) {
          expect(published).toBeUndefined();
          expect(Math.min(suppressed.n, suppressed.nSplits, suppressed.nRoxzone)).toBeLessThan(HYROX_S79_MIN_CELL_N);
        }
      }
    }
    // Singles have no mixed category; open doubles do.
    expect(HYROX_S79_PERCENTILES.open_singles.mixed).toBeUndefined();
    expect(HYROX_S79_PERCENTILES.open_doubles.mixed).toBeDefined();
  });

  it('every table is monotonic, on its DKW grid, and covers the median and quartiles', () => {
    for (const c of mainCells()) {
      const label = `${c.format}/${c.sex}/${c.metric}`;
      expectWellFormed(c.table, c.n, label);
      expect(HYROX_S79_GRIDS[c.format][c.sex]![c.metric]).toBe(finestGridFor(c.n)!.name);
      // Format x sex tables are large enough to cover the 1st to 99th percentile.
      expect(c.table[0][1], label).toBe(1);
      expect(c.table[c.table.length - 1][1], label).toBe(99);
    }
  });

  it('respects the lower total fence and never reaches past the slowest corroborated total', () => {
    const slowestKept = Math.max(HYROX_S79_INGEST_REPORT.keptAboveFenceMaxTotalSec,
      ...FORMATS.flatMap(f => SEXES.map(s => HYROX_S79_TOTAL_FENCES_SEC[f][s]?.hi ?? 0)));
    for (const c of mainCells().filter(x => x.metric === 'total')) {
      const f = HYROX_S79_TOTAL_FENCES_SEC[c.format][c.sex]!;
      expect(c.table[0][0]).toBeGreaterThanOrEqual(f.lo);
      expect(c.table[c.table.length - 1][0]).toBeLessThanOrEqual(slowestKept);
    }
  });

  it('run-leg medians exist for every published cell and are positive', () => {
    for (const format of FORMATS) {
      for (const sex of SEXES) {
        const legs = HYROX_S79_RUN_LEG_MEDIANS_SEC[format][sex];
        if (!HYROX_S79_PERCENTILES[format][sex]) { expect(legs).toBeUndefined(); continue; }
        expect(legs).toHaveLength(8);
        expect(legs!.every(x => Number.isInteger(x) && x > 0)).toBe(true);
      }
    }
  });
});

describe('HYROX S7-S9 results: counts reconcile with the ingest report', () => {
  const r = HYROX_S79_INGEST_REPORT;

  it('every input row is accounted for by exactly one rule', () => {
    const excluded = sum(Object.values(r.excludedDivisions));
    const dropped = r.droppedTotalMissing + r.droppedExactDuplicates
      + r.droppedCrossLabelAgeOnly + r.droppedCrossLabelResolved + r.droppedCrossLabelAmbiguous
      + r.droppedTotalBelowFence + r.droppedAboveFenceUncorroborated + r.droppedAboveFenceOneSegment
      + r.droppedInconsistent + r.droppedInconsistentUntimedRoxzone;
    expect(r.inputRows - excluded - dropped).toBe(r.rowsKeptForTotal);
    expect(r.totalOnlyMissingSplit + r.totalOnlySplitBelowFence + r.splitEligibleRoxzoneTimed
      + r.splitEligibleRoxzoneUntimed).toBe(r.rowsKeptForTotal);
    expect(r.splitEligibleRoxzoneTimed + r.splitEligibleRoxzoneUntimed).toBe(r.rowsKeptForSplits);
    expect(r.splitEligibleRoxzoneTimed).toBe(r.rowsKeptForRoxzone);
  });

  it('splits the missing-total drops into null and zero, and by event', () => {
    expect(r.droppedTotalMissingNull + r.droppedTotalMissingZero).toBe(r.droppedTotalMissing);
    expect(sum(r.droppedTotalMissingByEvent.map(e => e.rows))).toBe(r.droppedTotalMissing);
  });

  it('per-cell fence counts add up to the report', () => {
    const fences = FORMATS.flatMap(f => SEXES.map(s => HYROX_S79_TOTAL_FENCES_SEC[f][s]).filter(x => x != null));
    expect(sum(fences.map(f => f!.droppedBelow))).toBe(r.droppedTotalBelowFence);
    expect(sum(fences.map(f => f!.aboveFence))).toBe(r.aboveFenceRows);
    expect(sum(fences.map(f => f!.keptAboveCorroborated))).toBe(r.keptAboveFenceCorroborated);
    const excluded = sum(Object.values(r.excludedDivisions));
    expect(sum(fences.map(f => f!.rowsTested))).toBe(r.inputRows - excluded - r.droppedTotalMissing
      - r.droppedExactDuplicates - r.droppedCrossLabelAgeOnly - r.droppedCrossLabelResolved - r.droppedCrossLabelAmbiguous);
    for (const f of fences) {
      expect(f!.keptAboveCorroborated).toBeLessThanOrEqual(f!.aboveFence);
      expect(f!.maxSegmentShare > 0 && f!.maxSegmentShare < 1).toBe(true);
    }
  });

  it('every above-fence row is either corroborated or dropped by a named rule', () => {
    expect(r.keptAboveFenceCorroborated + r.droppedAboveFenceUncorroborated + r.droppedAboveFenceOneSegment
      + r.aboveFenceInconsistent).toBe(r.aboveFenceRows);
    expect(r.aboveFenceInconsistent).toBeLessThanOrEqual(r.droppedInconsistent + r.droppedInconsistentUntimedRoxzone);
    const [lo, hi] = r.droppedAboveFenceOneSegmentTotalRangeSec!;
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it('cross-label copies: chance matches ruled out, resolutions significant, counts reconcile', () => {
    expect(r.maxLog10ChanceMatchBound!).toBeLessThan(Math.log10(HYROX_S79_DKW_ALPHA));
    for (const c of HYROX_S79_CROSS_LABEL_RESOLUTIONS) {
      expect(c.signTestP).toBeLessThan(HYROX_S79_DKW_ALPHA);
      expect(c.votesKept).toBeGreaterThan(c.votesDropped);
      expect(c.votesKept + c.votesDropped + c.abstained).toBe(c.copies);
    }
    // Every copy group in the data is a pair, so one row goes per resolved copy.
    expect(sum(HYROX_S79_CROSS_LABEL_RESOLUTIONS.map(c => c.copies))).toBe(r.droppedCrossLabelResolved);
    // Ambiguous sets drop every copy, so their row count is a multiple of two.
    expect(r.droppedCrossLabelAmbiguous % 2).toBe(0);
    const ambiguousAge = sum(HYROX_S79_AGE_DROPS.filter(d => d.reason === 'ambiguous_age_label').map(d => d.rows));
    expect(ambiguousAge).toBeGreaterThan(0);
    expect(ambiguousAge).toBeLessThanOrEqual(r.droppedCrossLabelAgeOnly + r.droppedCrossLabelResolved);
  });

  it('published plus suppressed cell counts equal the rows kept per metric', () => {
    const cells = mainCells();
    const nFor = (m: HyroxResultsMetric) => sum(cells.filter(c => c.metric === m).map(c => c.n));
    const sup = HYROX_S79_SUPPRESSED_CELLS;
    expect(nFor('total') + sum(sup.map(c => c.n))).toBe(r.rowsKeptForTotal);
    expect(nFor('roxzone') + sum(sup.map(c => c.nRoxzone))).toBe(r.rowsKeptForRoxzone);
    for (const m of SPLIT_METRICS) expect(nFor(m) + sum(sup.map(c => c.nSplits))).toBe(r.rowsKeptForSplits);
  });

  it('split metrics share one row set; roxzone and splits are subsets of total', () => {
    for (const format of FORMATS) {
      for (const sex of SEXES) {
        const n = HYROX_S79_FINISHER_COUNTS[format][sex];
        if (!n) continue;
        for (const m of SPLIT_METRICS) expect(n[m]).toBe(n.run_total);
        expect(n.roxzone).toBeLessThanOrEqual(n.run_total);
        expect(n.run_total).toBeLessThanOrEqual(n.total);
      }
    }
  });

  it('season medians partition each cell and bracket the pooled median', () => {
    for (const format of FORMATS) {
      for (const sex of SEXES) {
        const n = HYROX_S79_FINISHER_COUNTS[format][sex];
        const rows = HYROX_S79_SEASON_MEDIANS.filter(x => x.format === format && x.sex === sex);
        if (!n) { expect(rows).toHaveLength(0); continue; }
        expect(rows.map(x => x.season)).toEqual([7, 8, 9]);
        expect(sum(rows.map(x => x.nTotal))).toBe(n.total);
        expect(sum(rows.map(x => x.nSplits))).toBe(n.run_total);
        // A pooled median always lies between the component medians (+-1 s rounding).
        for (const m of METRICS) {
          const pooled = at(HYROX_S79_PERCENTILES[format][sex]![m], 50)!;
          const seasonal = rows.map(x => x.medians[m]);
          expect(pooled, `${format}/${sex}/${m}`).toBeGreaterThanOrEqual(Math.min(...seasonal) - 1);
          expect(pooled, `${format}/${sex}/${m}`).toBeLessThanOrEqual(Math.max(...seasonal) + 1);
        }
      }
    }
  });

  it('same-venue season shifts cover every published cell for each pair of like half-seasons', () => {
    const published = mainCells().filter(c => c.metric === 'total');
    expect(HYROX_S79_SAME_VENUE_SEASON_SHIFT.length).toBe(published.length * 3);
    for (const s of HYROX_S79_SAME_VENUE_SEASON_SHIFT) {
      if (s.venuesTotal === 0) expect(s.medianShiftSec.total).toBeNull();
      else expect(Number.isInteger(s.medianShiftSec.total)).toBe(true);
    }
  });
});

describe('HYROX S8-S9 current-judging tables', () => {
  it('publish the same cells and metrics as the pooled tables, well formed on their DKW grid', () => {
    expect([...HYROX_S89_SEASONS]).toEqual([8, 9]);
    const cells = mainCells(CURRENT_JUDGING);
    expect(cells.length).toBe(mainCells().length);
    for (const c of cells) {
      const label = `S89 ${c.format}/${c.sex}/${c.metric}`;
      expectWellFormed(c.table, c.n, label);
      expect(HYROX_S89_GRIDS[c.format][c.sex]![c.metric]).toBe(finestGridFor(c.n)!.name);
    }
    for (const s of HYROX_S89_SUPPRESSED_CELLS) {
      expect(HYROX_S89_PERCENTILES[s.format][s.sex]).toBeUndefined();
      expect(Math.min(s.n, s.nSplits, s.nRoxzone)).toBeLessThan(HYROX_S79_MIN_CELL_N);
    }
  });

  it('counts equal the S8 plus S9 rows of the season table', () => {
    for (const format of FORMATS) {
      for (const sex of SEXES) {
        const n = HYROX_S89_FINISHER_COUNTS[format][sex];
        if (!n) continue;
        const rows = HYROX_S79_SEASON_MEDIANS.filter(x => x.format === format && x.sex === sex && x.season >= 8);
        expect(n.total).toBe(sum(rows.map(x => x.nTotal)));
        expect(n.run_total).toBe(sum(rows.map(x => x.nSplits)));
      }
    }
  });

  it("the judging step the header cites: open singles wall balls and sled push are slower in S8-S9 than pooled", () => {
    for (const sex of ['female', 'male'] as const) {
      for (const m of ['wall_balls', 'sled_push'] as const) {
        expect(at(HYROX_S89_PERCENTILES.open_singles[sex]![m], 50)!, `${sex}/${m}`)
          .toBeGreaterThan(at(HYROX_S79_PERCENTILES.open_singles[sex]![m], 50)!);
      }
    }
  });
});

describe('HYROX S7-S9 results: venue spread', () => {
  it('covers every published cell and metric with ordered quantiles and ratios', () => {
    for (const c of mainCells()) {
      const v = HYROX_S79_VENUE_SPREAD[c.format][c.sex]![c.metric];
      const label = `${c.format}/${c.sex}/${c.metric}`;
      expect(v.events, label).toBeGreaterThan(0);
      expect(v.p10 <= v.p50 && v.p50 <= v.p90, label).toBe(true);
      expect(v.ratioMin <= v.ratioP10 && v.ratioP10 <= v.ratioP90 && v.ratioP90 <= v.ratioMax, label).toBe(true);
    }
  });
});

describe('HYROX S7-S9 results: age-group tables', () => {
  it('every published age cell meets the minimum and sits on its DKW grid', () => {
    const cells = ageCells();
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.n).toBeGreaterThanOrEqual(HYROX_S79_MIN_CELL_N);
      expect(HYROX_S79_AGE_GROUPS[c.format]).toContain(c.band);
      expectWellFormed(c.table, c.n, `${c.format}/${c.sex}/${c.band}`);
    }
  });

  it('suppressed age cells are below the minimum and not published', () => {
    for (const s of HYROX_S79_AGE_SUPPRESSED_CELLS) {
      expect(s.n).toBeGreaterThan(0);
      expect(s.n).toBeLessThan(HYROX_S79_MIN_CELL_N);
      expect(HYROX_S79_AGE_TOTAL_PERCENTILES[s.format][s.sex]?.[s.ageGroup]).toBeUndefined();
    }
  });

  it('age rows plus suppressed plus dropped equal the total-table rows per format', () => {
    for (const format of FORMATS) {
      const totalRows = sum(SEXES.map(sex => HYROX_S79_FINISHER_COUNTS[format][sex]?.total ?? 0));
      const published = sum(ageCells().filter(c => c.format === format).map(c => c.n));
      const suppressed = sum(HYROX_S79_AGE_SUPPRESSED_CELLS.filter(c => c.format === format).map(c => c.n));
      const dropped = sum(HYROX_S79_AGE_DROPS.filter(c => c.format === format).map(c => c.rows));
      expect(published + suppressed + dropped, format).toBe(totalRows);
    }
  });

  it('doubles use the 10-year bands and singles the 5-year bands', () => {
    expect(HYROX_S79_AGE_GROUPS.open_doubles).toEqual(['16-29', '30-39', '40-49', '50-59', '60-69', '70+']);
    expect(HYROX_S79_AGE_GROUPS.pro_doubles).toEqual(HYROX_S79_AGE_GROUPS.open_doubles);
    expect(HYROX_S79_AGE_GROUPS.open_singles[0]).toBe('16-24');
    expect(HYROX_S79_AGE_GROUPS.pro_singles).toEqual(HYROX_S79_AGE_GROUPS.open_singles);
  });
});

describe('HYROX S7-S9 results: improvement tables', () => {
  const rep = HYROX_S79_IMPROVEMENT_REPORT;

  it('cut the band cells with the app\'s own HYROX_TIME_TO_BAND_THRESHOLDS', () => {
    // If the app's bands change, update BAND_THRESHOLDS in
    // scripts/ingest-hyrox-results-s79.py and regenerate the module.
    expect(HYROX_S79_IMPROVEMENT_BAND_THRESHOLDS).toEqual(HYROX_TIME_TO_BAND_THRESHOLDS);
  });

  it('every cell meets the minimum and has ordered quartiles', () => {
    for (const c of HYROX_S79_IMPROVEMENT) {
      expect(c.n).toBeGreaterThanOrEqual(HYROX_S79_MIN_CELL_N);
      expect(c.relPct[0]).toBeLessThanOrEqual(c.relPct[1]);
      expect(c.relPct[1]).toBeLessThanOrEqual(c.relPct[2]);
      expect(c.absPct[0]).toBeLessThanOrEqual(c.absPct[1]);
      expect(c.absPct[1]).toBeLessThanOrEqual(c.absPct[2]);
    }
    for (const s of HYROX_S79_IMPROVEMENT_SUPPRESSED) {
      expect(s.n).toBeGreaterThan(0);
      expect(s.n).toBeLessThan(HYROX_S79_MIN_CELL_N);
    }
  });

  it('counts reconcile with the repeat-athlete report', () => {
    expect(rep.inputRows - sum(Object.values(rep.dropped) as number[])).toBe(rep.used);
    const overall = HYROX_S79_IMPROVEMENT.find(c => c.format === 'all_singles' && c.sex === 'all'
      && c.band === 'all' && c.gapHalfSeasons === 'all')!;
    expect(overall.n).toBe(rep.used);
    const all = [...HYROX_S79_IMPROVEMENT, ...HYROX_S79_IMPROVEMENT_SUPPRESSED];
    const byGap = all.filter(c => c.format === 'all_singles' && c.sex === 'all' && c.band === 'all' && c.gapHalfSeasons !== 'all');
    expect(sum(byGap.map(c => c.n))).toBe(rep.used);
    expect(Object.fromEntries(byGap.map(c => [String(c.gapHalfSeasons), c.n]))).toEqual(rep.byGap);
    for (const groupBy of ['first_race', 'mean_of_races'] as const) {
      const byBand = all.filter(c => c.format === 'all_singles' && c.sex === 'all' && c.groupBy === groupBy
        && c.band !== 'all' && c.gapHalfSeasons === 'all');
      expect(sum(byBand.map(c => c.n)), groupBy).toBe(rep.used);
    }
  });
});

describe('HYROX S7-S9 results: smoke check against the brief', () => {
  // Brief's quick check: open women 95:55 and open men 87:57, "within a minute".
  it('open singles median totals match the quick check within a minute', () => {
    expect(Math.abs(at(HYROX_S79_PERCENTILES.open_singles.female!.total, 50)! - (95 * 60 + 55))).toBeLessThanOrEqual(60);
    expect(Math.abs(at(HYROX_S79_PERCENTILES.open_singles.male!.total, 50)! - (87 * 60 + 57))).toBeLessThanOrEqual(60);
  });

  it("open women's wall balls median sits near 6:42 (inside the table's p45 to p55 band)", () => {
    const wb = HYROX_S79_PERCENTILES.open_singles.female!.wall_balls;
    expect(at(wb, 45)!).toBeLessThanOrEqual(6 * 60 + 42);
    expect(at(wb, 55)!).toBeGreaterThanOrEqual(6 * 60 + 42);
  });
});
