/**
 * Honest HYROX population labels (audit 2026-10-12, item 5, labels only).
 *  - Captions of the results data name the format's finisher count, the
 *    seasons with years, that women and men are pooled, and the 75-rep Women
 *    Open era; doubles captions add the pooled-pairs caveat.
 *  - Station percentiles are synthetic and never captioned as results data.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  hyroxPopulationCaption,
  hyroxForecastProvenanceCaption,
  hyroxMethodologyCaption,
  STATION_PERCENTILE_CAVEAT,
} from './hyrox-population';
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
    expect(html).toMatch(/so these are estimates/);
    expect(html).not.toMatch(/not race results/);
  });
});

describe('forecast and methodology provenance captions', () => {
  it('the forecast caption says what comes from the data and what does not', () => {
    const singles = hyroxForecastProvenanceCaption('open_singles');
    expect(singles).toMatch(/ability-band seed times/);
    expect(singles).toMatch(/Finish percentiles are placed on the results data/);
    expect(singles).toContain(hyroxPopulationCaption('open_singles'));
    expect(singles).not.toMatch(/[Cc]alibrated against/);
    const doubles = hyroxForecastProvenanceCaption('open_doubles');
    expect(doubles).toMatch(/doubles station, Roxzone and run ratios/);
    expect(doubles).toMatch(/mixed pairs/);
    const proDoubles = hyroxForecastProvenanceCaption('pro_doubles');
    expect(proDoubles).toMatch(/Open Doubles results/);
    expect(proDoubles).toMatch(/no Pro Doubles rows/);
    for (const c of [singles, doubles, proDoubles]) expect(c).not.toContain('—');
  });
  it('the methodology caption reads its count and era from the data file', () => {
    const c = hyroxMethodologyCaption();
    const total = Object.values(HYROX_FORMAT_FINISHER_COUNTS).reduce((a, n) => a + n, 0);
    expect(c).toContain(total.toLocaleString('en-US'));
    expect(c).toMatch(/2021\/22 to 2023\/24/);
    expect(c).toMatch(/75 wall balls/);
    expect(c).toMatch(/station percentiles are estimates/);
    expect(c).not.toMatch(/[Cc]alibrated against/);
    expect(c).not.toContain('—');
  });
});

describe('no hardcoded HYROX finisher count outside the data file', () => {
  const SRC = join(__dirname, '..');
  const DATA_FILE = join(SRC, 'data', 'hyrox-population-distributions.ts');
  function appFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...appFiles(p));
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
    }
    return out;
  }
  it('captions derive the count from HYROX_FORMAT_FINISHER_COUNTS', () => {
    const offenders = appFiles(SRC)
      .filter(f => f !== DATA_FILE)
      .flatMap(f => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })))
      .filter(({ line }) => /\b89,?868\b/.test(line))
      .map(({ f, i }) => `${f.replace(SRC, 'src')}:${i}`);
    expect(offenders).toEqual([]);
  });
});
