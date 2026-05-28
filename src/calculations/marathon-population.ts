/**
 * Marathon + half population percentile lookups. Public API for UI surfaces.
 *
 * Mirrors `src/calculations/hyrox-population.ts`. Resolution order:
 *   1. Per-venue ingested table (richest signal, smallest cohort).
 *   2. Per-distance aggregate fallback (pooled across all ingested venues).
 *   3. null. Caller hides the population card.
 *
 * Science log: docs/SCIENCE_LOG.md §Marathon Population Distributions.
 */

import {
  isPopulationDataAvailable,
  lookupVenuePercentile,
  lookupDistanceAggregatePercentile,
  VENUE_PERCENTILE_TABLES,
  DISTANCE_AGGREGATE_PERCENTILE_TABLES,
  VENUE_DATA_PROVENANCE,
  type VenueId,
  type VenueDataProvenance,
  type PercentileTable,
} from '@/data/marathon-population-distributions';

/** Resolution source used by a percentile lookup, surfaced for the calibration
 *  caption so the UI can be honest about which dataset answered the query. */
export type PercentileSource = 'venue' | 'aggregate' | 'none';

export interface PercentileResult {
  /** "Faster than X%" — 0..100. */
  fasterThanPct: number;
  /** Where the answer came from. */
  source: PercentileSource;
  /** Provenance of the venue table when source === 'venue'; null otherwise. */
  provenance: VenueDataProvenance | null;
}

/**
 * Compute a finish-time percentile against the best available distribution.
 *
 * Returns null when neither the per-venue table nor the distance aggregate has
 * any data ingested. Caller should hide the population surface entirely
 * rather than show a placeholder.
 */
export function getMarathonFinishPercentile(
  venueId: VenueId | null | undefined,
  distance: 'marathon' | 'half',
  timeSec: number,
): PercentileResult | null {
  if (!isPopulationDataAvailable()) return null;
  if (!Number.isFinite(timeSec) || timeSec <= 0) return null;

  // 1. Per-venue table first.
  if (venueId) {
    const venueCum = lookupVenuePercentile(venueId, timeSec);
    if (venueCum != null) {
      return {
        fasterThanPct: Math.max(0, Math.min(100, 100 - venueCum)),
        source: 'venue',
        provenance: VENUE_DATA_PROVENANCE[venueId] ?? null,
      };
    }
  }

  // 2. Distance aggregate fallback.
  const aggCum = lookupDistanceAggregatePercentile(distance, timeSec);
  if (aggCum != null) {
    return {
      fasterThanPct: Math.max(0, Math.min(100, 100 - aggCum)),
      source: 'aggregate',
      provenance: null,
    };
  }

  return null;
}

/** Compact label from "faster than X%". Same shape as hyrox-population. */
export function percentileLabel(fasterThanPct: number): string {
  if (fasterThanPct >= 99) return 'Top 1%';
  if (fasterThanPct >= 95) return 'Top 5%';
  if (fasterThanPct >= 90) return 'Top 10%';
  if (fasterThanPct >= 75) return `Top ${100 - fasterThanPct}%`;
  if (fasterThanPct >= 55) return `Top ${100 - fasterThanPct}%`;
  if (fasterThanPct >= 45) return 'Median';
  if (fasterThanPct >= 25) return `Bottom ${fasterThanPct}%`;
  if (fasterThanPct >= 10) return `Bottom ${fasterThanPct}%`;
  if (fasterThanPct >= 5)  return 'Bottom 10%';
  return 'Below typical finishing range';
}

/** Hero headline phrasing. At extremes "faster than 1%" reads weirdly. */
export function percentileHeadline(fasterThanPct: number): string {
  if (fasterThanPct >= 5) return `Faster than ${fasterThanPct}% of finishers`;
  return 'Below typical finishing range';
}

export interface ResolvedDistribution {
  /** The cumulative-percentile table the UI should draw. */
  table: PercentileTable;
  /** Where the table came from. */
  source: 'venue' | 'aggregate';
  /** Venue provenance when source === 'venue', null otherwise. */
  provenance: VenueDataProvenance | null;
}

/**
 * Resolve which distribution table the UI should draw for a given venue +
 * distance. Same fallback chain as `getMarathonFinishPercentile`. Per-venue
 * first, then per-distance aggregate. Returns null when no data is available.
 *
 * UI callers (e.g. the population card) need the raw breakpoints to build a
 * PDF curve. This is the same shape the percentile lookup uses internally;
 * exposing it lets the card render without duplicating the resolution logic.
 */
export function resolveMarathonDistribution(
  venueId: VenueId | null | undefined,
  distance: 'marathon' | 'half',
): ResolvedDistribution | null {
  if (!isPopulationDataAvailable()) return null;

  if (venueId) {
    const venueTable = VENUE_PERCENTILE_TABLES[venueId];
    if (venueTable && venueTable.length > 0) {
      return { table: venueTable, source: 'venue', provenance: VENUE_DATA_PROVENANCE[venueId] ?? null };
    }
  }

  const aggTable = DISTANCE_AGGREGATE_PERCENTILE_TABLES[distance];
  if (aggTable && aggTable.length > 0) {
    return { table: aggTable, source: 'aggregate', provenance: null };
  }

  return null;
}

/** Caption naming the dataset behind a per-venue answer. Used directly under
 *  the population card. Returns null when source is aggregate or none. The
 *  caller writes its own caption for those cases. */
export function venueCalibrationCaption(result: PercentileResult): string | null {
  if (result.source !== 'venue' || !result.provenance) return null;
  const p = result.provenance;
  const nFmt = p.n ? p.n.toLocaleString() : null;
  const yearsBit = p.years ? ` (${p.years})` : '';
  const attrBit = p.attribution ? ` ${p.attribution}` : '';
  if (nFmt) {
    return `Calibrated from ${nFmt} finishes at this venue${yearsBit}.${attrBit}`;
  }
  return `Calibrated from this venue's published results${yearsBit}.${attrBit}`;
}
