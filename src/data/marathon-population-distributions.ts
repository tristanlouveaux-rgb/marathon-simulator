/**
 * Marathon + half-marathon population distributions — real outcome data.
 *
 * Mirrors `src/data/hyrox-population-distributions.ts` in structure.
 * One percentile table per venue (where data is available), plus a per-
 * distance aggregate fallback so any venue without per-venue data still
 * gets a sensible distribution.
 *
 * ## How to populate this file
 *
 * 1. Download a finisher CSV from Kaggle (`runningwithrock/*`,
 *    `kevinegan/london-marathon-results`, `aiaiaidavid/berlin-marathons-data`,
 *    `rojour/boston-results`, etc.) — see `docs/SCIENCE_LOG.md` for the
 *    full data-source survey.
 * 2. Run: `node scripts/ingest-marathon-results.mjs <csv-path> <venue-id>`
 * 3. Paste the printed const block into the appropriate table below.
 * 4. Update `VENUE_DATA_PROVENANCE` with source, n, years.
 * 5. Bump `LAST_REFRESH_DATE` and ensure `POPULATION_DATA_AVAILABLE` stays true.
 *
 * Venue ids match `src/data/marathons.ts`.
 */

/** Date this file was last refreshed against the source datasets. */
export const LAST_REFRESH_DATE = '2026-05-18';

/** Derived flag — true if any per-venue or distance-aggregate table has data
 *  ingested. Callers should hide the population card entirely when false.
 *  Computed dynamically so the flag can never drift out of sync with the
 *  underlying tables (and so tests can populate tables without flipping a
 *  separate boolean). */
export function isPopulationDataAvailable(): boolean {
  for (const k of Object.keys(VENUE_PERCENTILE_TABLES)) {
    if (VENUE_PERCENTILE_TABLES[k].length > 0) return true;
  }
  return DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon.length > 0
    || DISTANCE_AGGREGATE_PERCENTILE_TABLES.half.length > 0;
}

/** Type alias for clarity — matches Marathon.id in `data/marathons.ts`. */
export type VenueId = string;

/** Per-venue cumulative percentile table.
 *  Each entry: `[finishTimeSec, cumulativePercentile]`.
 *  `cumulativePercentile` = % of finishers slower than or equal to this time.
 *  Sorted ascending by finishTimeSec. */
export type PercentileTable = Array<[number, number]>;

/** Per-venue tables. Empty array = no data for this venue yet (falls back to
 *  the distance aggregate). Populated via the ingestion script. */
export const VENUE_PERCENTILE_TABLES: Record<VenueId, PercentileTable> = {
  // ── Marathons ──────────────────────────────────────────────────────────────
  // Ingested 2026-05-18 from AndrewMillerOnline/marathon-results (GitHub, MIT-licensed).
  london:  [[9877, 1], [11093, 5], [12027, 10], [13786, 25], [15941, 50], [18409, 75], [20899, 90], [22529, 95], [25517, 99]],
  berlin:  [[9734, 1], [10880, 5], [11737, 10], [13160, 25], [14809, 50], [16953, 75], [19085, 90], [20468, 95], [22621, 99]],
  chicago: [[10237, 1], [11553, 5], [12435, 10], [14049, 25], [16273, 50], [18854, 75], [21385, 90], [22843, 95], [25436, 99]],
  nyc:     [[10328, 1], [11735, 5], [12629, 10], [14226, 25], [16209, 50], [18590, 75], [21059, 90], [22644, 95], [25638, 99]],
  tokyo: [],
  boston:  [[8923, 1], [9683, 5], [10162, 10], [11115, 25], [12409, 50], [14061, 75], [16052, 90], [17449, 95], [20435, 99]],
  paris: [],
  amsterdam: [],
  sydney: [],
  melbourne: [],
  dubai: [],
  seoul: [],
  valencia: [],
  barcelona: [],
  rome: [],
  toronto: [],
  manchester: [],
  edinburgh: [],
  'copenhagen-marathon': [],
  'stockholm-marathon': [],
  'helsinki-marathon': [],
  'reykjavik-marathon': [],
  'frankfurt-marathon': [],
  'dublin-marathon': [],

  // ── Half marathons ─────────────────────────────────────────────────────────
  'great-north': [],
  'nyc-half': [],
  'big-half': [],
  'lisbon-half': [],
  'copenhagen-half': [],
  'delhi-half': [],
  'cardiff-half': [],
  'berlin-half': [],
  'leeds-half': [],
  'hackney-half': [],
  'edinburgh-half': [],
  'liverpool-half': [],
  'oslo-half': [],
  'helsinki-half': [],
  'brighton-marathon-half-relay': [],
  'reykjavik-half': [],
  'bristol-half': [],
  'nottingham-half': [],
};

/** Per-distance aggregate fallback. Used when a venue has no per-venue table.
 *  Populated by pooling the largest available datasets across all venues at
 *  that distance during ingestion. */
export const DISTANCE_AGGREGATE_PERCENTILE_TABLES: Record<'marathon' | 'half', PercentileTable> = {
  // Pooled from 5 venues (Berlin, Boston, Chicago, London, NYC), 888,989 raw
  // finishes, via scripts/fetch-marathon-github.mjs — 2026-05-18.
  marathon: [[9453, 1], [10553, 5], [11305, 10], [12894, 25], [15013, 50], [17575, 75], [20153, 90], [21702, 95], [24618, 99]],
  half: [],
};

/** Provenance metadata per venue — drives the calibration caption on the UI.
 *  `source: 'none'` is the default and means we have no real data for this
 *  venue (the distance aggregate will be used). */
export interface VenueDataProvenance {
  source: 'kaggle' | 'official-scrape' | 'aggregator-scrape' | 'preliminary-aggregate' | 'none';
  /** Approximate finisher count behind the table. */
  n: number | null;
  /** Year range (e.g. "2015-2024"). */
  years: string | null;
  /** One-line dataset attribution for captions. */
  attribution: string | null;
  /** Whether the source includes intermediate splits (5K/10K/half/30K). */
  hasSplits: boolean;
  /** Free-text notes — caveats, calibration choices, etc. */
  notes?: string;
}

export const VENUE_DATA_PROVENANCE: Record<VenueId, VenueDataProvenance> = {
  // All venues start as 'none'. Ingestion script updates the relevant entries.
  london:                          { source: 'official-scrape', n: 35886,  years: '2014-2018', attribution: 'Source: AndrewMillerOnline/marathon-results (GitHub, MIT).', hasSplits: true, notes: 'Source data has empty time_full for ~80% of rows — only finishers with complete time records included.' },
  berlin:                          { source: 'official-scrape', n: 196316, years: '2015-2019', attribution: 'Source: AndrewMillerOnline/marathon-results (GitHub, MIT).', hasSplits: true },
  chicago:                         { source: 'official-scrape', n: 207295, years: '2014-2018', attribution: 'Source: AndrewMillerOnline/marathon-results (GitHub, MIT).', hasSplits: true },
  nyc:                             { source: 'official-scrape', n: 253309, years: '2015-2019', attribution: 'Source: AndrewMillerOnline/marathon-results (GitHub, MIT).', hasSplits: true },
  tokyo:                           { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  boston:                          { source: 'official-scrape', n: 196183, years: '1897-2000', attribution: 'Source: AndrewMillerOnline/marathon-results (GitHub, MIT).', hasSplits: true, notes: 'Historical data only — modern Boston (2001+) is in Kaggle rojour/boston-results, not yet ingested. Older fields skew faster due to qualifier-only entry; women not represented pre-1972.' },
  paris:                           { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  amsterdam:                       { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  sydney:                          { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  melbourne:                       { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  dubai:                           { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  seoul:                           { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  valencia:                        { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  barcelona:                       { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  rome:                            { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  toronto:                         { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  manchester:                      { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  edinburgh:                       { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'copenhagen-marathon':           { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'stockholm-marathon':            { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'helsinki-marathon':             { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'reykjavik-marathon':            { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'frankfurt-marathon':            { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'dublin-marathon':               { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'great-north':                   { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'nyc-half':                      { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'big-half':                      { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'lisbon-half':                   { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'copenhagen-half':               { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'delhi-half':                    { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'cardiff-half':                  { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'berlin-half':                   { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'leeds-half':                    { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'hackney-half':                  { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'edinburgh-half':                { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'liverpool-half':                { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'oslo-half':                     { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'helsinki-half':                 { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'brighton-marathon-half-relay':  { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'reykjavik-half':                { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'bristol-half':                  { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
  'nottingham-half':               { source: 'none', n: null, years: null, attribution: null, hasSplits: false },
};

/**
 * Look up a percentile from a real distribution table. Returns null when the
 * table is empty (no data ingested yet). Caller falls back to the distance
 * aggregate or hides the surface entirely.
 *
 * Result is the cumulative percentile (% of finishers slower than or equal
 * to `timeSec`). Caller converts to "faster than X%" via `100 - result`.
 *
 * Mirrors `lookupRealPercentile` in `hyrox-population-distributions.ts`.
 */
export function lookupVenuePercentile(
  venueId: VenueId,
  timeSec: number,
): number | null {
  const t = VENUE_PERCENTILE_TABLES[venueId];
  if (!t || t.length === 0) return null;
  if (timeSec <= t[0][0]) return t[0][1];
  if (timeSec >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    const [t0, p0] = t[i - 1];
    const [t1, p1] = t[i];
    if (timeSec <= t1) {
      const frac = (timeSec - t0) / (t1 - t0);
      return Math.round(p0 + frac * (p1 - p0));
    }
  }
  return 100;
}

/**
 * Look up against the distance aggregate. Used when the per-venue table is
 * empty. Returns null when even the aggregate has no data ingested.
 */
export function lookupDistanceAggregatePercentile(
  distance: 'marathon' | 'half',
  timeSec: number,
): number | null {
  const t = DISTANCE_AGGREGATE_PERCENTILE_TABLES[distance];
  if (!t || t.length === 0) return null;
  if (timeSec <= t[0][0]) return t[0][1];
  if (timeSec >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 1; i < t.length; i++) {
    const [t0, p0] = t[i - 1];
    const [t1, p1] = t[i];
    if (timeSec <= t1) {
      const frac = (timeSec - t0) / (t1 - t0);
      return Math.round(p0 + frac * (p1 - p0));
    }
  }
  return 100;
}
