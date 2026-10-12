/**
 * Honest HYROX population labels (audit 2026-10-12, item 5, labels only).
 *  - Captions of the results data name the format's finisher count, the
 *    seasons with years, that women and men are pooled, and the 75-rep Women
 *    Open era; doubles captions add the pooled-pairs caveat.
 *  - Station percentiles are synthetic and never captioned as results data.
 */
import { describe, it, expect } from 'vitest';
import { hyroxPopulationCaption, STATION_PERCENTILE_CAVEAT } from './hyrox-population';
import { renderPerformanceRadar } from '@/ui/hyrox/performance-radar';
import { HYROX_FORMAT_FINISHER_COUNTS } from '@/data/hyrox-population-distributions';
import { HYROX_STATION_ORDER, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import type { HyroxStationLine } from './race-prediction.hyrox';

describe('hyroxPopulationCaption', () => {
  it('open singles: format count, seasons with years, pooled sexes, 75-rep era', () => {
    const c = hyroxPopulationCaption('open_singles');
    expect(c).toContain(HYROX_FORMAT_FINISHER_COUNTS.open_singles.toLocaleString('en-US'));
    expect(c).toContain('Open Singles');
    expect(c).toContain('2021/22 to 2023/24');
    expect(c).toContain('women and men together');
    expect(c).toMatch(/75 wall balls/);
    expect(c).not.toMatch(/Live/);
    expect(c).not.toContain('—');
  });
  it('open doubles adds the pooled-pairs caveat', () => {
    expect(hyroxPopulationCaption('open_doubles')).toMatch(/pool women's, men's and mixed pairs/);
    expect(hyroxPopulationCaption('open_singles')).not.toMatch(/mixed pairs/);
  });
  it('pro doubles has no rows and says the scale is synthetic', () => {
    const c = hyroxPopulationCaption('pro_doubles');
    expect(c).toMatch(/no Pro Doubles rows/);
    expect(c).toMatch(/Approximate/);
  });
});

describe('station percentiles are labelled as estimates', () => {
  it('the caveat says estimates, not results data', () => {
    expect(STATION_PERCENTILE_CAVEAT).toMatch(/estimates/);
    expect(STATION_PERCENTILE_CAVEAT).toMatch(/no per-station splits/);
  });
  it('the radar subtitle no longer claims a results-data comparison', () => {
    const lines: HyroxStationLine[] = HYROX_STATION_ORDER.map(st => ({
      station: st,
      baseSec: STATION_SEED_TIMES_SEC.intermediate[st],
      adjustedSec: STATION_SEED_TIMES_SEC.intermediate[st],
      source: 'calibrated',
    }));
    const html = renderPerformanceRadar({ stations: lines });
    expect(html).not.toMatch(/S4.S6 field/);
    expect(html).not.toMatch(/top 1%/);
    expect(html).toMatch(/Estimates, not race results/);
  });
});
