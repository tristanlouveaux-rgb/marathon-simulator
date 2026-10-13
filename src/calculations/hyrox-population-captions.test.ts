/**
 * Honest HYROX population labels.
 *  - Captions of the results data lead with provenance: the seasons with
 *    years, the cohort's finisher count, and the source attribution.
 *  - Station percentiles are real race-split percentiles (lane H3b); the
 *    "estimate on the seed times" wording is gone.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  hyroxPopulationCaption,
  hyroxForecastProvenanceCaption,
  hyroxMethodologyCaption,
  hyroxPopulationTotalFinishers,
  STATION_PERCENTILE_CAVEAT,
} from './hyrox-population';
import { renderPerformanceRadar } from '@/ui/hyrox/performance-radar';
import {
  HYROX_S89_FINISHER_COUNTS,
  HYROX_S89_POOLED_FINISHER_COUNTS,
  HYROX_S89_SEASONS_LABEL,
  HYROX_RESULTS_VIA,
} from '@/data/hyrox-results-s79';
import { HYROX_STATION_ORDER, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import type { HyroxStationLine } from './race-prediction.hyrox';

describe('hyroxPopulationCaption', () => {
  it('pooled open singles: seasons with years, the format count, women and men, the source', () => {
    const c = hyroxPopulationCaption('open_singles');
    expect(c.startsWith(`HYROX results, ${HYROX_S89_SEASONS_LABEL}`)).toBe(true);
    expect(c).toContain(HYROX_S89_POOLED_FINISHER_COUNTS.open_singles!.total.toLocaleString('en-US'));
    expect(c).toContain('Open Singles finishers (women and men)');
    expect(c).toContain(HYROX_RESULTS_VIA);
    expect(c).not.toMatch(/75 wall balls/);
    expect(c).not.toContain('—');
  });
  it('a sex cohort names the cohort and its own count', () => {
    const c = hyroxPopulationCaption('open_singles', { format: 'open_singles', sex: 'female' });
    expect(c).toContain(`${HYROX_S89_FINISHER_COUNTS.open_singles.female!.total.toLocaleString('en-US')} Open Singles women finishers`);
  });
  it('open doubles pooled names the mixed pairs; a division names its pairs', () => {
    expect(hyroxPopulationCaption('open_doubles')).toMatch(/and mixed pairs/);
    expect(hyroxPopulationCaption('open_singles')).not.toMatch(/mixed pairs/);
    expect(hyroxPopulationCaption('open_doubles', { format: 'open_doubles', sex: 'mixed' })).toContain('Open Doubles mixed finishers');
  });
  it('pro doubles has real rows now', () => {
    const c = hyroxPopulationCaption('pro_doubles');
    expect(c).toContain(HYROX_S89_POOLED_FINISHER_COUNTS.pro_doubles!.total.toLocaleString('en-US'));
    expect(c).not.toMatch(/synthetic|Approximate/);
  });
});

describe('station percentiles are real race-split percentiles', () => {
  it('the caveat says what they compare, with no estimate wording', () => {
    expect(STATION_PERCENTILE_CAVEAT).toMatch(/race splits/);
    expect(STATION_PERCENTILE_CAVEAT).not.toMatch(/estimate|no per-station splits/);
  });
  it('the radar subtitle leads with the results provenance and no longer calls the spokes estimates', () => {
    const lines: HyroxStationLine[] = HYROX_STATION_ORDER.map(st => ({
      station: st,
      baseSec: STATION_SEED_TIMES_SEC.intermediate[st],
      adjustedSec: STATION_SEED_TIMES_SEC.intermediate[st],
      source: 'calibrated',
    }));
    const html = renderPerformanceRadar({ stations: lines });
    expect(html).toContain(HYROX_S89_SEASONS_LABEL);
    expect(html).not.toMatch(/so these are estimates/);
    expect(html).not.toMatch(/band seed times/);
  });
});

describe('forecast and methodology provenance captions', () => {
  it('the forecast caption says what comes from the data and what does not', () => {
    const singles = hyroxForecastProvenanceCaption('open_singles');
    expect(singles).toMatch(/median split of your ability band/);
    expect(singles).toContain(hyroxPopulationCaption('open_singles'));
    expect(singles).not.toMatch(/[Cc]alibrated against/);
    const doubles = hyroxForecastProvenanceCaption('open_doubles');
    expect(doubles).toMatch(/ratios from the doubles results/);
    const proDoubles = hyroxForecastProvenanceCaption('pro_doubles');
    expect(proDoubles).toMatch(/Open weights convert to Pro weights/);
    expect(proDoubles).toContain(hyroxPopulationCaption('pro_doubles'));
    for (const c of [singles, doubles, proDoubles]) expect(c).not.toContain('—');
  });
  it('the methodology caption reads its count and seasons from the data file', () => {
    const c = hyroxMethodologyCaption();
    expect(c).toContain(hyroxPopulationTotalFinishers().toLocaleString('en-US'));
    expect(c).toContain(HYROX_S89_SEASONS_LABEL);
    expect(c).toMatch(/station percentiles by format and sex/);
    expect(c).not.toMatch(/estimates/);
    expect(c).not.toContain('—');
  });
});

describe('no hardcoded HYROX finisher count outside the data file', () => {
  const SRC = join(__dirname, '..');
  const DATA_FILES = [
    join(SRC, 'data', 'hyrox-population-distributions.ts'),
    join(SRC, 'data', 'hyrox-results-s79.ts'),
  ];
  const counts = [
    89868,
    hyroxPopulationTotalFinishers(),
    ...Object.values(HYROX_S89_POOLED_FINISHER_COUNTS).map(c => c!.total),
  ];
  function appFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...appFiles(p));
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
    }
    return out;
  }
  it('captions derive every finisher count from the data modules', () => {
    const patterns = counts.map(n => {
      const digits = String(n);
      const grouped = n.toLocaleString('en-US');
      return new RegExp(`\\b(${digits}|${grouped.replace(/,/g, ',')})\\b`);
    });
    const offenders = appFiles(SRC)
      .filter(f => !DATA_FILES.includes(f))
      .flatMap(f => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })))
      .filter(({ line }) => patterns.some(re => re.test(line)))
      .map(({ f, i }) => `${f.replace(SRC, 'src')}:${i}`);
    expect(offenders).toEqual([]);
  });
});
