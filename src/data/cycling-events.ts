/**
 * Famous cycling events with course-profile facts. Lookup by id; surfaces
 * elevation, course profile, climate, and altitude into the cycling predictor.
 *
 * Sources: official event websites, Strava segment elevation aggregates,
 * historic race-week weather. Refresh annually.
 *
 * Climate anchored to wet-bulb temperature (matches triathlon-course-factors):
 *   cool 10–14°C, temperate 15–19°C, warm 20–25°C, hot 26–30°C, hot-humid 30°C+ RH>70%.
 *
 * `altitudeM` = highest sustained altitude on the course (or peak point). For
 * Alpine sportives this is typically the top of the highest pass.
 */

export interface CyclingEvent {
  id: string;
  name: string;
  city: string;
  country: string;
  /** Typical month — used for default race-day climate. */
  monthHint: string;
  /** Course distance in km (default route). */
  distanceKm: number;
  /** Total elevation gain in metres. */
  elevationM: number;
  /** Categorical course shape — fed into the bike-physics fallback. */
  courseProfile: 'flat' | 'rolling' | 'hilly' | 'mountainous';
  /** Race-day climate at typical event date. */
  climate: 'cool' | 'temperate' | 'warm' | 'hot' | 'hot-humid';
  /** Highest sustained altitude on the course in metres. */
  altitudeM: number;
  notes?: string;
}

export const CYCLING_EVENTS: CyclingEvent[] = [
  {
    id: 'etape-du-tour',
    name: 'L’Étape du Tour',
    city: 'Variable (Tour stage)',
    country: 'France',
    monthHint: 'July',
    distanceKm: 170,
    elevationM: 4500,
    courseProfile: 'mountainous',
    climate: 'warm',
    altitudeM: 2400,
    notes: 'Replicates a Tour de France mountain stage. High Alpine passes; warm summer weather but cold descents.',
  },
  {
    id: 'marmotte',
    name: 'La Marmotte',
    city: 'Bourg d’Oisans',
    country: 'France',
    monthHint: 'July',
    distanceKm: 174,
    elevationM: 5000,
    courseProfile: 'mountainous',
    climate: 'warm',
    altitudeM: 2645,
    notes: 'Glandon, Télégraphe, Galibier, Alpe d’Huez. One of the toughest single-day amateur sportives in the world.',
  },
  {
    id: 'maratona-dolomites',
    name: 'Maratona dles Dolomites',
    city: 'Corvara',
    country: 'Italy',
    monthHint: 'July',
    distanceKm: 138,
    elevationM: 4230,
    courseProfile: 'mountainous',
    climate: 'temperate',
    altitudeM: 2240,
    notes: 'Seven Dolomite passes including Pordoi and Giau. High altitude and steep gradients.',
  },
  {
    id: 'haute-route-alps',
    name: 'Haute Route Alps (queen stage)',
    city: 'Various',
    country: 'France',
    monthHint: 'August',
    distanceKm: 130,
    elevationM: 4000,
    courseProfile: 'mountainous',
    climate: 'warm',
    altitudeM: 2700,
    notes: 'Multi-day stage race; this profile is typical of the queen stage.',
  },
  {
    id: 'ride-london',
    name: 'RideLondon-Essex 100',
    city: 'London',
    country: 'United Kingdom',
    monthHint: 'May',
    distanceKm: 161,
    elevationM: 800,
    courseProfile: 'rolling',
    climate: 'cool',
    altitudeM: 100,
    notes: 'Closed roads through London and Essex. Mostly flat with a few rolling sections.',
  },
  {
    id: 'mallorca-312',
    name: 'Mallorca 312',
    city: 'Playa de Muro',
    country: 'Spain',
    monthHint: 'April',
    distanceKm: 312,
    elevationM: 5050,
    courseProfile: 'mountainous',
    climate: 'temperate',
    altitudeM: 1500,
    notes: 'Tramuntana mountains then a flat south-east loop. Warm and exposed in mid-April.',
  },
  {
    id: 'tour-of-cambridgeshire',
    name: 'Tour of Cambridgeshire Gran Fondo',
    city: 'Peterborough',
    country: 'United Kingdom',
    monthHint: 'June',
    distanceKm: 130,
    elevationM: 700,
    courseProfile: 'rolling',
    climate: 'temperate',
    altitudeM: 50,
    notes: 'Closed roads through the Fens; mostly flat with some rolling sections.',
  },
  {
    id: 'leadville-100',
    name: 'Leadville Trail 100 MTB',
    city: 'Leadville, Colorado',
    country: 'USA',
    monthHint: 'August',
    distanceKm: 161,
    elevationM: 3700,
    courseProfile: 'mountainous',
    climate: 'temperate',
    altitudeM: 3840,
    notes: 'Highest sustained altitude of any major bike event. Severe altitude limiter — Columbine summit 3840m.',
  },
  {
    id: 'gran-fondo-ny',
    name: 'Gran Fondo New York',
    city: 'New York',
    country: 'USA',
    monthHint: 'May',
    distanceKm: 161,
    elevationM: 2400,
    courseProfile: 'hilly',
    climate: 'warm',
    altitudeM: 400,
    notes: 'Bear Mountain climbs; warm spring weather.',
  },
  {
    id: 'tour-de-yorkshire',
    name: 'Tour de Yorkshire Ride',
    city: 'Various',
    country: 'United Kingdom',
    monthHint: 'May',
    distanceKm: 130,
    elevationM: 2200,
    courseProfile: 'hilly',
    climate: 'cool',
    altitudeM: 600,
    notes: 'Rolling Yorkshire Dales with sustained climbs. Cool spring weather, often wet.',
  },
];

export function getCyclingEventById(id: string): CyclingEvent | undefined {
  return CYCLING_EVENTS.find(e => e.id === id);
}
