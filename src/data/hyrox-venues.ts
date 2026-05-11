/**
 * HYROX venue dataset — per-event characteristics that produce small but
 * measurable course-time differences.
 *
 * **Confidence: low-medium.** Hyrox is identical-format (15 stations, 8×1km
 * runs) so venue differences are smaller than running/cycling course factors.
 * Values below are inferred from athlete reports, finishing-time spreads
 * across venues at the same season, and venue floor-plan analysis. Treat as
 * heuristic adjustments, not literature-grade coefficients. Refresh as more
 * structured data becomes available.
 *
 * Three dimensions:
 *
 * 1. **Floor surface** affects sled push/pull stations primarily. Standard
 *    Hyrox flooring is rubber matting with turf insets at sled stations.
 *    Some venues use mixed surfaces (carpet/rubber transitions) which adds
 *    inconsistency. Rare: pure-concrete venues feel faster on the run loop
 *    but slower on sleds.
 *      rubber:    canonical, no adjustment.
 *      mixed:     +5s/sled station (12s total across 2 sled stations).
 *      concrete:  +10s/sled, but −5s on each 1km run (cleaner surface).
 *
 * 2. **Lap difficulty** captures the run-loop geometry — long straights vs
 *    tight S-curves through narrow corridors. Each 1km run is ~3-5min; a
 *    tight venue adds ~10-15s per lap.
 *      easy:      long straights, wide corners. ~1.5% faster on each run.
 *      standard:  typical convention-centre layout. No adjustment.
 *      hard:      tight S-curves, narrow corridors. ~3% slower on each run.
 *
 * 3. **Temperature** affects sustained effort. Convention-centre HVAC varies.
 *      cool:      15–19°C. No adjustment.
 *      standard:  20–24°C. No adjustment.
 *      warm:      25–28°C. ~1.5% slower across run + endurance stations.
 *      hot:       29°C+. ~3% slower; rare in practice but noted for record.
 */

export type HyroxFloorSurface = 'rubber' | 'mixed' | 'concrete';
export type HyroxLapDifficulty = 'easy' | 'standard' | 'hard';
export type HyroxTempTendency = 'cool' | 'standard' | 'warm' | 'hot';

export interface HyroxVenue {
  id: string;
  name: string;
  city: string;
  country: string;
  floorSurface: HyroxFloorSurface;
  lapDifficulty: HyroxLapDifficulty;
  tempTendency: HyroxTempTendency;
  /** Venue altitude in metres (only Mexico City is meaningful). */
  altitudeM: number;
  notes?: string;
}

export const HYROX_VENUES: HyroxVenue[] = [
  { id: 'london-excel',         name: 'London ExCeL',           city: 'London',         country: 'United Kingdom', floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 5,    notes: 'Largest UK venue. Standard ExCeL hall layout with one long straight per lap.' },
  { id: 'manchester-central',   name: 'Manchester Central',     city: 'Manchester',     country: 'United Kingdom', floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'cool',     altitudeM: 38,   notes: 'Cooler venue than London. Standard layout.' },
  { id: 'birmingham-nec',       name: 'Birmingham NEC',         city: 'Birmingham',     country: 'United Kingdom', floorSurface: 'rubber',   lapDifficulty: 'easy',     tempTendency: 'standard', altitudeM: 105,  notes: 'Wide hall with long straights — slightly faster lap geometry.' },
  { id: 'glasgow-sec',          name: 'Glasgow SEC',            city: 'Glasgow',        country: 'United Kingdom', floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'cool',     altitudeM: 5,    notes: 'Cool Scottish venue.' },
  { id: 'berlin-trade-fair',    name: 'Messe Berlin',           city: 'Berlin',         country: 'Germany',        floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 34,   notes: 'Original Hyrox spiritual home.' },
  { id: 'hamburg',              name: 'Hamburg Messe',          city: 'Hamburg',        country: 'Germany',        floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'cool',     altitudeM: 6,    notes: 'Cool maritime climate.' },
  { id: 'cologne',              name: 'Koelnmesse',             city: 'Cologne',        country: 'Germany',        floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 60,   notes: 'Large hall with standard layout.' },
  { id: 'amsterdam-rai',        name: 'Amsterdam RAI',          city: 'Amsterdam',      country: 'Netherlands',    floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'cool',     altitudeM: 0,    notes: 'Dutch venue; cool climate.' },
  { id: 'stockholm-msm',        name: 'Stockholmsmässan',       city: 'Stockholm',      country: 'Sweden',         floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'cool',     altitudeM: 10,   notes: 'Cool Nordic venue.' },
  { id: 'paris-portes',         name: 'Paris Porte de Versailles', city: 'Paris',       country: 'France',         floorSurface: 'rubber',   lapDifficulty: 'hard',     tempTendency: 'standard', altitudeM: 35,   notes: 'Tighter run loop reported; some narrow sections.' },
  { id: 'madrid-ifema',         name: 'IFEMA Madrid',           city: 'Madrid',         country: 'Spain',          floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'warm',     altitudeM: 660,  notes: 'Warm + mild altitude. Spanish summer events run hot.' },
  { id: 'barcelona-ffm',        name: 'Fira de Barcelona',      city: 'Barcelona',      country: 'Spain',          floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'warm',     altitudeM: 12,   notes: 'Warm Mediterranean climate.' },
  { id: 'milan-fiera',          name: 'Fiera Milano',           city: 'Milan',          country: 'Italy',          floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'warm',     altitudeM: 122,  notes: 'Warm Italian summer events.' },
  { id: 'vegas-mandalay',       name: 'Mandalay Bay',           city: 'Las Vegas',      country: 'USA',            floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 610,  notes: 'World Championship venue. Indoor AC keeps temp standard despite desert.' },
  { id: 'nyc-javits',           name: 'Javits Center',          city: 'New York',       country: 'USA',            floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 5,    notes: 'Large convention centre layout.' },
  { id: 'la-conv',              name: 'LA Convention Center',   city: 'Los Angeles',    country: 'USA',            floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'warm',     altitudeM: 90,   notes: 'Warm climate; venue HVAC variable.' },
  { id: 'singapore-expo',       name: 'Singapore EXPO',         city: 'Singapore',      country: 'Singapore',      floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'warm',     altitudeM: 15,   notes: 'Tropical climate; even with AC, ambient heat is a factor.' },
  { id: 'hk-aws',               name: 'AsiaWorld-Expo',         city: 'Hong Kong',      country: 'Hong Kong',      floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'warm',     altitudeM: 10,   notes: 'Tropical climate; hall is large and well-aired.' },
  { id: 'sydney-icc',           name: 'ICC Sydney',             city: 'Sydney',         country: 'Australia',      floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 5,    notes: 'Modern venue with consistent climate control.' },
  { id: 'melbourne-mcec',       name: 'Melbourne Convention',   city: 'Melbourne',      country: 'Australia',      floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 30,   notes: 'Standard Australian venue.' },
  { id: 'dubai-wtc',            name: 'Dubai World Trade Centre', city: 'Dubai',        country: 'UAE',            floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 5,    notes: 'Strong AC compensates for outside heat.' },
  { id: 'mexico-city-exh',      name: 'Centro Citibanamex',     city: 'Mexico City',    country: 'Mexico',         floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 2240, notes: 'Significant altitude — primary limiter for visiting athletes.' },
  { id: 'toronto-mtcc',         name: 'Metro Toronto Convention', city: 'Toronto',      country: 'Canada',         floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'cool',     altitudeM: 76,   notes: 'Cool Canadian winter venue.' },
  { id: 'sao-paulo-trans',      name: 'Transamerica Expo',      city: 'São Paulo',      country: 'Brazil',         floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'warm',     altitudeM: 760,  notes: 'Warm climate; mild altitude.' },
  { id: 'cape-town-ctcc',       name: 'CTICC',                  city: 'Cape Town',      country: 'South Africa',   floorSurface: 'rubber',   lapDifficulty: 'standard', tempTendency: 'standard', altitudeM: 10,   notes: 'Coastal venue; mild climate.' },
];

export function getHyroxVenueById(id: string): HyroxVenue | undefined {
  return HYROX_VENUES.find(v => v.id === id);
}

/**
 * Multipliers applied per dimension. See file header for derivation logic.
 * Each multiplier > 1.0 makes the corresponding component slower.
 */
export const HYROX_FLOOR_RUN_MULTIPLIER: Record<HyroxFloorSurface, number> = {
  rubber:   1.000,
  mixed:    1.000,
  concrete: 0.995,  // cleaner run surface
};

export const HYROX_FLOOR_SLED_DELTA_SEC: Record<HyroxFloorSurface, number> = {
  rubber:   0,
  mixed:    +6,    // per sled station (×2 stations = +12s total)
  concrete: +10,
};

export const HYROX_LAP_RUN_MULTIPLIER: Record<HyroxLapDifficulty, number> = {
  easy:     0.985,
  standard: 1.000,
  hard:     1.030,
};

export const HYROX_TEMP_RUN_MULTIPLIER: Record<HyroxTempTendency, number> = {
  cool:     1.000,
  standard: 1.000,
  warm:     1.015,
  hot:      1.030,
};

/** Affects compounding metabolic stations (rower, ski, sandbag, burpees). */
export const HYROX_TEMP_STATION_MULTIPLIER: Record<HyroxTempTendency, number> = {
  cool:     1.000,
  standard: 1.000,
  warm:     1.012,
  hot:      1.025,
};

/**
 * Coarse "overall" venue multiplier covering run + endurance stations + sled deltas.
 * Used when scaling a previous finish time from one venue to another (informational).
 * Approximates the % impact at a typical singles distribution of run/station/transition time.
 */
export function overallVenueMultiplier(venueId: string | undefined): number {
  if (!venueId) return 1.0;
  const v = getHyroxVenueById(venueId);
  if (!v) return 1.0;
  // Typical singles: 32 min run, 32 min stations (~5 endurance × ~4 min), 6 min roxzone, 2 sled stations.
  // We blend run/station temp + run lap + run floor + sled floor delta into one approximate scalar.
  const runMult = HYROX_FLOOR_RUN_MULTIPLIER[v.floorSurface]
                * HYROX_LAP_RUN_MULTIPLIER[v.lapDifficulty]
                * HYROX_TEMP_RUN_MULTIPLIER[v.tempTendency];
  const stationMult = HYROX_TEMP_STATION_MULTIPLIER[v.tempTendency];
  // Weighted: 40% run, 50% stations (5 of 8 are endurance), 10% transitions.
  const blended = 0.40 * runMult + 0.50 * stationMult + 0.10;
  // Add ~12 sec across 70-min total for sled-floor delta on mixed/concrete (~0.3%).
  const sledFudge = HYROX_FLOOR_SLED_DELTA_SEC[v.floorSurface] / (70 * 60);
  return blended + sledFudge;
}

/** Convert a finish time from one venue's conditions to another's.
 *  `fromVenueId` describes where the time was set; `toVenueId` is the target.
 *  Returns equivalent time at the target venue. */
export function rescaleTimeAcrossVenues(
  timeSec: number,
  fromVenueId: string | undefined,
  toVenueId: string | undefined,
): number {
  const fromMult = overallVenueMultiplier(fromVenueId);
  const toMult   = overallVenueMultiplier(toVenueId);
  if (fromMult === 0) return timeSec;
  return Math.round(timeSec * (toMult / fromMult));
}
