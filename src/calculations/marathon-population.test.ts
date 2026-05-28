import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getMarathonFinishPercentile,
  percentileLabel,
  percentileHeadline,
  venueCalibrationCaption,
  type PercentileResult,
} from './marathon-population';
import * as DistMod from '@/data/marathon-population-distributions';

// We mutate the module's internal tables directly to keep the test self-
// contained — no Kaggle dataset required. The exported tables are mutable
// objects (Records / arrays), which mirrors how the ingestion script will
// eventually populate the file.

const ORIG_VENUE_TABLES = { ...DistMod.VENUE_PERCENTILE_TABLES };
const ORIG_DISTANCE_TABLES = {
  marathon: [...DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon],
  half: [...DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.half],
};
const ORIG_PROVENANCE = { ...DistMod.VENUE_DATA_PROVENANCE };

function clearAllTables(): void {
  for (const k of Object.keys(DistMod.VENUE_PERCENTILE_TABLES)) {
    DistMod.VENUE_PERCENTILE_TABLES[k] = [];
  }
  DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon = [];
  DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.half = [];
}

function restoreAll(): void {
  for (const k of Object.keys(ORIG_VENUE_TABLES)) {
    DistMod.VENUE_PERCENTILE_TABLES[k] = ORIG_VENUE_TABLES[k];
  }
  DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon = ORIG_DISTANCE_TABLES.marathon;
  DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.half = ORIG_DISTANCE_TABLES.half;
  for (const k of Object.keys(ORIG_PROVENANCE)) {
    DistMod.VENUE_DATA_PROVENANCE[k] = ORIG_PROVENANCE[k];
  }
}

describe('getMarathonFinishPercentile', () => {
  beforeEach(() => clearAllTables());
  afterEach(() => restoreAll());

  it('returns null when no venue or aggregate table has any data', () => {
    // isPopulationDataAvailable() returns false naturally when all tables are empty.
    expect(getMarathonFinishPercentile('london', 'marathon', 14400)).toBeNull();
  });

  it('uses venue table when available', () => {
    // 3:00:00 → 1st percentile, 4:00:00 → 50th, 5:00:00 → 99th
    DistMod.VENUE_PERCENTILE_TABLES.london = [[10800, 1], [14400, 50], [18000, 99]];
    const r = getMarathonFinishPercentile('london', 'marathon', 14400);
    expect(r).not.toBeNull();
    expect(r!.source).toBe('venue');
    expect(r!.fasterThanPct).toBe(50);
  });

  it('falls back to distance aggregate when venue table is empty', () => {
    DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon = [[10800, 1], [14400, 50], [18000, 99]];
    const r = getMarathonFinishPercentile('london', 'marathon', 14400);
    expect(r).not.toBeNull();
    expect(r!.source).toBe('aggregate');
    expect(r!.fasterThanPct).toBe(50);
    expect(r!.provenance).toBeNull();
  });

  it('falls back to distance aggregate when venueId is null', () => {
    DistMod.DISTANCE_AGGREGATE_PERCENTILE_TABLES.half = [[3600, 1], [5400, 50], [7200, 99]];
    const r = getMarathonFinishPercentile(null, 'half', 5400);
    expect(r).not.toBeNull();
    expect(r!.source).toBe('aggregate');
    expect(r!.fasterThanPct).toBe(50);
  });

  it('interpolates between percentile breakpoints', () => {
    DistMod.VENUE_PERCENTILE_TABLES.london = [[10800, 1], [14400, 50]];
    // Halfway between 3:00:00 and 4:00:00 → halfway between 1 and 50 → ~25
    const r = getMarathonFinishPercentile('london', 'marathon', 12600);
    expect(r).not.toBeNull();
    expect(r!.fasterThanPct).toBeCloseTo(74, 0); // 100 - 26
  });

  it('clamps to the edges of the table', () => {
    DistMod.VENUE_PERCENTILE_TABLES.london = [[10800, 1], [14400, 50], [18000, 99]];
    const veryFast = getMarathonFinishPercentile('london', 'marathon', 7200); // 2:00
    expect(veryFast!.fasterThanPct).toBe(99);
    const verySlow = getMarathonFinishPercentile('london', 'marathon', 21600); // 6:00
    expect(verySlow!.fasterThanPct).toBe(1);
  });

  it('returns null for non-finite or non-positive times', () => {
    DistMod.VENUE_PERCENTILE_TABLES.london = [[10800, 1], [14400, 50], [18000, 99]];
    expect(getMarathonFinishPercentile('london', 'marathon', NaN)).toBeNull();
    expect(getMarathonFinishPercentile('london', 'marathon', -1)).toBeNull();
    expect(getMarathonFinishPercentile('london', 'marathon', 0)).toBeNull();
  });

  it('attaches provenance for venue-source results', () => {
    DistMod.VENUE_PERCENTILE_TABLES.london = [[10800, 1], [14400, 50], [18000, 99]];
    DistMod.VENUE_DATA_PROVENANCE.london = {
      source: 'kaggle', n: 42000, years: '2014-2023',
      attribution: 'Kaggle test', hasSplits: true,
    };
    const r = getMarathonFinishPercentile('london', 'marathon', 14400);
    expect(r!.provenance).not.toBeNull();
    expect(r!.provenance!.n).toBe(42000);
    expect(r!.provenance!.source).toBe('kaggle');
  });
});

describe('percentileLabel', () => {
  it('maps top-tier scores to "Top X%"', () => {
    expect(percentileLabel(99)).toBe('Top 1%');
    expect(percentileLabel(95)).toBe('Top 5%');
    expect(percentileLabel(90)).toBe('Top 10%');
    expect(percentileLabel(80)).toBe('Top 20%');
  });

  it('uses "Median" for the middle band', () => {
    expect(percentileLabel(50)).toBe('Median');
    expect(percentileLabel(45)).toBe('Median');
  });

  it('maps bottom-tier scores to "Bottom X%"', () => {
    expect(percentileLabel(25)).toBe('Bottom 25%');
    expect(percentileLabel(10)).toBe('Bottom 10%');
    expect(percentileLabel(5)).toBe('Bottom 10%');
  });

  it('handles extreme low scores', () => {
    expect(percentileLabel(0)).toBe('Below typical finishing range');
  });
});

describe('percentileHeadline', () => {
  it('renders a "faster than X%" headline above the floor', () => {
    expect(percentileHeadline(75)).toBe('Faster than 75% of finishers');
  });

  it('switches to descriptive text at the bottom', () => {
    expect(percentileHeadline(4)).toBe('Below typical finishing range');
    expect(percentileHeadline(0)).toBe('Below typical finishing range');
  });
});

describe('venueCalibrationCaption', () => {
  it('formats a venue-source caption with n + years + attribution', () => {
    const r: PercentileResult = {
      fasterThanPct: 50, source: 'venue',
      provenance: { source: 'kaggle', n: 42000, years: '2014-2023', attribution: 'Source: Kaggle.', hasSplits: true },
    };
    expect(venueCalibrationCaption(r)).toBe('Calibrated from 42,000 finishes at this venue (2014-2023). Source: Kaggle.');
  });

  it('returns null for aggregate-source results', () => {
    expect(venueCalibrationCaption({ fasterThanPct: 50, source: 'aggregate', provenance: null })).toBeNull();
  });

  it('returns null when venue-source has no provenance attached', () => {
    expect(venueCalibrationCaption({ fasterThanPct: 50, source: 'venue', provenance: null })).toBeNull();
  });
});
