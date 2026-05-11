/**
 * HYROX World Series event database.
 *
 * 2026 events: verified against hyrox.com/find-my-race on 2026-05-07 and
 * marked `verified: true`. Multi-day events use the start date.
 *
 * 2024–2025 events: historical, marked unverified — kept for the previous-time
 * provenance picker (athletes recalling which past race their time came from).
 * Specific dates may be approximate; weekend they fell on is the more useful
 * signal for venue resolution.
 *
 * Refresh cadence: re-verify against hyrox.com/find-my-race at the start of
 * each season cycle (every ~3 months) and update the `verified` flag.
 */

export interface HyroxEvent {
  id: string;
  name: string;
  city: string;
  country: string;
  date: string; // ISO date (YYYY-MM-DD)
  /** True if the date has been confirmed against hyrox.com. Default: undefined = unverified. */
  verified?: boolean;
}

export const HYROX_WORLD_SERIES: HyroxEvent[] = [
  // ── 2022 (S1–S2 historical — approximate weekend dates, unverified) ────────
  { id: 'cologne-2022',         name: 'HYROX Cologne',         city: 'Cologne',     country: 'Germany',        date: '2022-10-29' },
  { id: 'london-2022',          name: 'HYROX London',          city: 'London',      country: 'United Kingdom', date: '2022-11-19' },
  { id: 'amsterdam-2022',       name: 'HYROX Amsterdam',       city: 'Amsterdam',   country: 'Netherlands',    date: '2022-12-03' },
  // ── 2023 (S3–S4 historical) ─────────────────────────────────────────────────
  { id: 'sydney-2023',          name: 'HYROX Sydney',          city: 'Sydney',      country: 'Australia',      date: '2023-01-21' },
  { id: 'melbourne-2023',       name: 'HYROX Melbourne',       city: 'Melbourne',   country: 'Australia',      date: '2023-02-11' },
  { id: 'manchester-2023',      name: 'HYROX Manchester',      city: 'Manchester',  country: 'United Kingdom', date: '2023-03-04' },
  { id: 'stockholm-2023',       name: 'HYROX Stockholm',       city: 'Stockholm',   country: 'Sweden',         date: '2023-03-18' },
  { id: 'chicago-2023',         name: 'HYROX Chicago',         city: 'Chicago',     country: 'United States',  date: '2023-04-15' },
  { id: 'las-vegas-2023',       name: 'HYROX Las Vegas',       city: 'Las Vegas',   country: 'United States',  date: '2023-04-29' },
  { id: 'berlin-2023',          name: 'HYROX Berlin',          city: 'Berlin',      country: 'Germany',        date: '2023-05-13' },
  { id: 'london-2023',          name: 'HYROX London',          city: 'London',      country: 'United Kingdom', date: '2023-06-10' },
  { id: 'tokyo-2023',           name: 'HYROX Tokyo',           city: 'Tokyo',       country: 'Japan',          date: '2023-09-30' },
  { id: 'hamburg-2023',         name: 'HYROX Hamburg',         city: 'Hamburg',     country: 'Germany',        date: '2023-10-14' },
  { id: 'cologne-2023',         name: 'HYROX Cologne',         city: 'Cologne',     country: 'Germany',        date: '2023-10-28' },
  { id: 'amsterdam-2023',       name: 'HYROX Amsterdam',       city: 'Amsterdam',   country: 'Netherlands',    date: '2023-11-11' },
  { id: 'dubai-2023',           name: 'HYROX Dubai',           city: 'Dubai',       country: 'UAE',            date: '2023-12-09' },
  // ── 2024 (S4–S5 historical — full year, approximate weekends) ──────────────
  { id: 'sydney-2024',          name: 'HYROX Sydney',          city: 'Sydney',      country: 'Australia',      date: '2024-01-27' },
  { id: 'melbourne-2024',       name: 'HYROX Melbourne',       city: 'Melbourne',   country: 'Australia',      date: '2024-02-17' },
  { id: 'singapore-2024',       name: 'HYROX Singapore',       city: 'Singapore',   country: 'Singapore',      date: '2024-03-02' },
  { id: 'manchester-2024-mar',  name: 'HYROX Manchester',      city: 'Manchester',  country: 'United Kingdom', date: '2024-03-09' },
  { id: 'stockholm-2024',       name: 'HYROX Stockholm',       city: 'Stockholm',   country: 'Sweden',         date: '2024-03-23' },
  { id: 'chicago-2024',         name: 'HYROX Chicago',         city: 'Chicago',     country: 'United States',  date: '2024-04-06' },
  { id: 'barcelona-2024',       name: 'HYROX Barcelona',       city: 'Barcelona',   country: 'Spain',          date: '2024-04-20' },
  { id: 'berlin-2024',          name: 'HYROX Berlin',          city: 'Berlin',      country: 'Germany',        date: '2024-05-11' },
  { id: 'london-2024-jun',      name: 'HYROX London',          city: 'London',      country: 'United Kingdom', date: '2024-06-15' },
  { id: 'hamburg-2024',         name: 'HYROX Hamburg',         city: 'Hamburg',     country: 'Germany',        date: '2024-09-21' },
  { id: 'cologne-2024',         name: 'HYROX Cologne',         city: 'Cologne',     country: 'Germany',        date: '2024-10-26' },
  { id: 'amsterdam-2024',       name: 'HYROX Amsterdam',       city: 'Amsterdam',   country: 'Netherlands',    date: '2024-11-09' },
  { id: 'london-2024',          name: 'HYROX London',          city: 'London',      country: 'United Kingdom', date: '2024-11-23' },
  { id: 'manchester-2024',      name: 'HYROX Manchester',      city: 'Manchester',  country: 'United Kingdom', date: '2024-12-14' },
  // ── 2025 ────────────────────────────────────────────────────────────────────
  { id: 'sydney-2025',      name: 'HYROX Sydney',       city: 'Sydney',       country: 'Australia',      date: '2025-01-25' },
  { id: 'melbourne-2025',   name: 'HYROX Melbourne',    city: 'Melbourne',    country: 'Australia',      date: '2025-02-15' },
  { id: 'nice-2025',        name: 'HYROX Nice',         city: 'Nice',         country: 'France',         date: '2025-03-08' },
  { id: 'manchester-2025',  name: 'HYROX Manchester',   city: 'Manchester',   country: 'United Kingdom', date: '2025-03-15' },
  { id: 'stockholm-2025',   name: 'HYROX Stockholm',    city: 'Stockholm',    country: 'Sweden',         date: '2025-03-22' },
  { id: 'chicago-2025',     name: 'HYROX Chicago',      city: 'Chicago',      country: 'United States',  date: '2025-04-05' },
  { id: 'berlin-2025',      name: 'HYROX Berlin',       city: 'Berlin',       country: 'Germany',        date: '2025-05-10' },
  { id: 'london-2025',      name: 'HYROX London',       city: 'London',       country: 'United Kingdom', date: '2025-06-14' },
  { id: 'hamburg-2025',     name: 'HYROX Hamburg',      city: 'Hamburg',      country: 'Germany',        date: '2025-10-11' },
  { id: 'frankfurt-2025',   name: 'HYROX Frankfurt',    city: 'Frankfurt',    country: 'Germany',        date: '2025-11-01' },
  // ── 2026 (verified against hyrox.com/find-my-race on 2026-05-07) ───────────
  // Multi-day events use the start date. Where a city hosts multiple events in
  // 2026, suffix the id with the month (e.g. barcelona-may-2026 vs barcelona-nov-2026).
  // "Date coming soon" entries omitted (Abu Dhabi, Singapore, Melbourne).
  // Youngstars-only entries omitted (separate junior event).
  { id: 'hong-kong-2026',            name: 'Cigna HYROX Hong Kong',                      city: 'Hong Kong',     country: 'Hong Kong',      date: '2026-05-08', verified: true },
  { id: 'helsinki-may-2026',         name: 'HYROX Helsinki',                             city: 'Helsinki',      country: 'Finland',        date: '2026-05-09', verified: true },
  { id: 'ottawa-2026',               name: 'GoodLife HYROX Ottawa',                      city: 'Ottawa',        country: 'Canada',         date: '2026-05-14', verified: true },
  { id: 'barcelona-may-2026',        name: 'Bioterm HYROX Barcelona',                    city: 'Barcelona',     country: 'Spain',          date: '2026-05-14', verified: true },
  { id: 'heerenveen-2026',           name: 'HYROX Heerenveen',                           city: 'Heerenveen',    country: 'Netherlands',    date: '2026-05-14', verified: true },
  { id: 'incheon-2026',              name: 'AirAsia HYROX Incheon',                      city: 'Incheon',       country: 'South Korea',    date: '2026-05-15', verified: true },
  { id: 'puebla-2026',               name: 'HYROX Puebla',                               city: 'Puebla',        country: 'Mexico',         date: '2026-05-16', verified: true },
  { id: 'shanghai-may-2026',         name: '24/7 FITNESS HYROX Shanghai',                city: 'Shanghai',      country: 'China',          date: '2026-05-16', verified: true },
  { id: 'lyon-2026',                 name: 'Creapure HYROX Lyon',                        city: 'Lyon',          country: 'France',         date: '2026-05-20', verified: true },
  { id: 'berlin-may-2026',           name: 'GilletteLabs HYROX Berlin',                  city: 'Berlin',        country: 'Germany',        date: '2026-05-22', verified: true },
  { id: 'new-york-2026',             name: 'NYU Langone Health HYROX New York',          city: 'New York',      country: 'United States',  date: '2026-05-28', verified: true },
  { id: 'rimini-2026',               name: 'HYROX Rimini',                               city: 'Rimini',        country: 'Italy',          date: '2026-05-28', verified: true },
  { id: 'riga-2026',                 name: 'Lemon Gym HYROX Riga',                       city: 'Riga',          country: 'Latvia',         date: '2026-05-30', verified: true },
  { id: 'johannesburg-may-2026',     name: 'Virgin Active HYROX Johannesburg',           city: 'Johannesburg',  country: 'South Africa',   date: '2026-05-30', verified: true },
  { id: 'buenos-aires-2026',         name: 'HYROX Buenos Aires',                         city: 'Buenos Aires',  country: 'Argentina',      date: '2026-06-13', verified: true },
  { id: 'stockholm-worldchamps-2026',name: 'PUMA HYROX World Championships Stockholm',   city: 'Stockholm',     country: 'Sweden',         date: '2026-06-18', verified: true },
  { id: 'jakarta-2026',              name: 'AirAsia HYROX Jakarta',                      city: 'Jakarta',       country: 'Indonesia',      date: '2026-06-27', verified: true },
  { id: 'sydney-2026',               name: 'BYD HYROX Sydney',                           city: 'Sydney',        country: 'Australia',      date: '2026-07-01', verified: true },
  { id: 'hangzhou-2026',             name: 'TORRAS HYROX Hangzhou',                      city: 'Hangzhou',      country: 'China',          date: '2026-07-04', verified: true },
  { id: 'delhi-2026',                name: "Finers' Union HYROX Delhi",                  city: 'Delhi',         country: 'India',          date: '2026-07-24', verified: true },
  { id: 'chengdu-2026',              name: 'HYROX Chengdu',                              city: 'Chengdu',       country: 'China',          date: '2026-08-01', verified: true },
  { id: 'istanbul-2026',             name: 'HYROX Istanbul',                             city: 'Istanbul',      country: 'Turkey',         date: '2026-08-01', verified: true },
  { id: 'chiba-2026',                name: 'AirAsia HYROX Chiba',                        city: 'Chiba',         country: 'Japan',          date: '2026-08-07', verified: true },
  { id: 'bangkok-2026',              name: 'BYD HYROX Bangkok',                          city: 'Bangkok',       country: 'Thailand',       date: '2026-08-14', verified: true },
  { id: 'cape-town-2026',            name: 'Virgin Active HYROX Cape Town',              city: 'Cape Town',     country: 'South Africa',   date: '2026-08-14', verified: true },
  { id: 'shenzhen-2026',             name: 'HYROX Shenzhen',                             city: 'Shenzhen',      country: 'China',          date: '2026-08-15', verified: true },
  { id: 'perth-2026',                name: 'AirAsia HYROX Perth',                        city: 'Perth',         country: 'Australia',      date: '2026-08-21', verified: true },
  { id: 'washington-dc-2026',        name: 'Amazfit HYROX Washington D.C.',              city: 'Washington DC', country: 'United States',  date: '2026-09-03', verified: true },
  { id: 'tenerife-2026',             name: 'HYROX Tenerife',                             city: 'Tenerife',      country: 'Spain',          date: '2026-09-04', verified: true },
  { id: 'acapulco-2026',             name: 'HYROX Acapulco',                             city: 'Acapulco',      country: 'Mexico',         date: '2026-09-05', verified: true },
  { id: 'maastricht-2026',           name: 'HYROX Maastricht',                           city: 'Maastricht',    country: 'Netherlands',    date: '2026-09-17', verified: true },
  { id: 'mumbai-2026',               name: "Masters' Union HYROX Mumbai",                city: 'Mumbai',        country: 'India',          date: '2026-09-18', verified: true },
  { id: 'salt-lake-city-2026',       name: 'InBody HYROX Salt Lake City',                city: 'Salt Lake City',country: 'United States',  date: '2026-09-18', verified: true },
  { id: 'rome-2026',                 name: 'HYROX Rome',                                 city: 'Rome',          country: 'Italy',          date: '2026-09-24', verified: true },
  { id: 'oslo-2026',                 name: 'HYROX Oslo',                                 city: 'Oslo',          country: 'Norway',         date: '2026-09-25', verified: true },
  { id: 'bordeaux-2026',             name: 'INTERSPORT HYROX Bordeaux',                  city: 'Bordeaux',      country: 'France',         date: '2026-09-30', verified: true },
  { id: 'toronto-2026',              name: 'GoodLife HYROX Toronto',                     city: 'Toronto',       country: 'Canada',         date: '2026-10-01', verified: true },
  { id: 'boston-2026',               name: 'HWPO HYROX Boston',                          city: 'Boston',        country: 'United States',  date: '2026-10-08', verified: true },
  { id: 'geneva-2026',               name: "Let's Go Fitness HYROX Geneva",              city: 'Geneva',        country: 'Switzerland',    date: '2026-10-09', verified: true },
  { id: 'gdansk-2026',                name: 'HYROX Gdańsk',                               city: 'Gdańsk',        country: 'Poland',         date: '2026-10-10', verified: true },
  { id: 'valencia-oct-2026',         name: 'HYROX Valencia',                             city: 'Valencia',      country: 'Spain',          date: '2026-10-16', verified: true },
  { id: 'sao-paulo-2026',            name: 'HYROX São Paulo',                            city: 'São Paulo',     country: 'Brazil',         date: '2026-10-17', verified: true },
  { id: 'tampa-2026',                name: 'HYROX Tampa',                                city: 'Tampa',         country: 'United States',  date: '2026-10-23', verified: true },
  { id: 'birmingham-oct-2026',       name: 'HYROX Birmingham',                           city: 'Birmingham',    country: 'United Kingdom', date: '2026-10-27', verified: true },
  { id: 'hamburg-2026',               name: 'Intersport HYROX Hamburg',                   city: 'Hamburg',       country: 'Germany',        date: '2026-10-28', verified: true },
  { id: 'nice-2026',                  name: 'TRAINSWEATEAT HYROX Nice',                   city: 'Nice',          country: 'France',         date: '2026-10-29', verified: true },
  { id: 'mexico-city-2026',           name: 'HYROX Mexico City',                          city: 'Mexico City',   country: 'Mexico',         date: '2026-10-30', verified: true },
  { id: 'shanghai-oct-2026',          name: 'HYROX Shanghai',                             city: 'Shanghai',      country: 'China',          date: '2026-10-31', verified: true },
  { id: 'dublin-2026',                name: 'HYROX Dublin',                               city: 'Dublin',        country: 'Ireland',        date: '2026-11-11', verified: true },
  { id: 'dusseldorf-2026',            name: 'HYROX Düsseldorf',                           city: 'Düsseldorf',    country: 'Germany',        date: '2026-11-11', verified: true },
  { id: 'barcelona-nov-2026',         name: 'HYROX Barcelona',                            city: 'Barcelona',     country: 'Spain',          date: '2026-11-12', verified: true },
  { id: 'denver-2026',                name: 'HYROX Denver',                               city: 'Denver',        country: 'United States',  date: '2026-11-12', verified: true },
  { id: 'seoul-2026',                 name: 'AirAsia HYROX Seoul',                        city: 'Seoul',         country: 'South Korea',    date: '2026-11-14', verified: true },
  { id: 'dallas-2026',                name: 'HYROX Dallas',                               city: 'Dallas',        country: 'United States',  date: '2026-11-18', verified: true },
  { id: 'poznan-2026',                name: 'HYROX Poznań',                               city: 'Poznań',        country: 'Poland',         date: '2026-11-20', verified: true },
  { id: 'guangzhou-2026',             name: 'HYROX Guangzhou',                            city: 'Guangzhou',     country: 'China',          date: '2026-11-21', verified: true },
  { id: 'utrecht-2026',               name: 'HYROX Utrecht',                              city: 'Utrecht',       country: 'Netherlands',    date: '2026-11-26', verified: true },
  { id: 'johannesburg-nov-2026',      name: 'Virgin Active HYROX Johannesburg',           city: 'Johannesburg',  country: 'South Africa',   date: '2026-11-28', verified: true },
  { id: 'london-dec-2026',            name: 'HYROX London ExCel',                         city: 'London',        country: 'United Kingdom', date: '2026-12-02', verified: true },
  { id: 'anaheim-2026',               name: 'HYROX Anaheim',                              city: 'Anaheim',       country: 'United States',  date: '2026-12-04', verified: true },
  { id: 'milan-2026',                 name: 'HYROX Milan',                                city: 'Milan',         country: 'Italy',          date: '2026-12-05', verified: true },
  { id: 'sanya-2026',                 name: 'HYROX Sanya',                                city: 'Sanya',         country: 'China',          date: '2026-12-05', verified: true },
  { id: 'frankfurt-2026',             name: 'Fitness First HYROX Frankfurt',              city: 'Frankfurt',     country: 'Germany',        date: '2026-12-10', verified: true },
  { id: 'nashville-2026',             name: 'HYROX Nashville',                            city: 'Nashville',     country: 'United States',  date: '2026-12-10', verified: true },
  { id: 'paris-2026',                 name: 'FITNESS PARK HYROX Paris',                   city: 'Paris',         country: 'France',         date: '2026-12-12', verified: true },
  { id: 'gent-2026',                  name: 'HYROX Gent',                                 city: 'Gent',          country: 'Belgium',        date: '2026-12-17', verified: true },
  { id: 'helsinki-dec-2026',          name: 'HYROX Helsinki',                             city: 'Helsinki',      country: 'Finland',        date: '2026-12-18', verified: true },
  { id: 'vancouver-2026',             name: 'HYROX Vancouver',                            city: 'Vancouver',     country: 'Canada',         date: '2026-12-18', verified: true },
];

/** Return only future events relative to a given ISO date string. */
export function getFutureHyroxEvents(fromDateISO: string): HyroxEvent[] {
  return HYROX_WORLD_SERIES.filter(e => e.date > fromDateISO);
}

/** Return only past events relative to a given ISO date string, ordered most-recent first. */
export function getPastHyroxEvents(fromDateISO: string): HyroxEvent[] {
  return HYROX_WORLD_SERIES.filter(e => e.date <= fromDateISO).slice().sort((a, b) => b.date.localeCompare(a.date));
}

/** Look up an event by id. */
export function getHyroxEventById(id: string): HyroxEvent | undefined {
  return HYROX_WORLD_SERIES.find(e => e.id === id);
}

/** Map an event to its canonical venue id by city (best-effort).
 *  HYROX events typically run at a single venue per city; the first match wins. */
export function getVenueIdForEvent(eventId: string): string | undefined {
  // Lazily import to avoid circular: hyrox-venues imports nothing from us.
  const ev = getHyroxEventById(eventId);
  if (!ev) return undefined;
  // City-name → venue-id mapping for the few cities that need disambiguation
  // (e.g. Las Vegas multiple venues). Default: first city match in HYROX_VENUES.
  const overrides: Record<string, string> = {
    'Las Vegas':   'vegas-mandalay',
    'Berlin':      'berlin-trade-fair',
    'Hamburg':     'hamburg',
    'Cologne':     'cologne',
    'Amsterdam':   'amsterdam-rai',
    'Stockholm':   'stockholm-msm',
    'London':      'london-excel',
    'Manchester':  'manchester-central',
    'Glasgow':     'glasgow-sec',
    'Birmingham':  'birmingham-nec',
    'Paris':       'paris-portes',
    'Madrid':      'madrid-ifema',
    'Barcelona':   'barcelona-ffm',
    'Milan':       'milan-fiera',
    'New York':    'nyc-javits',
    'Los Angeles': 'la-conv',
    'Singapore':   'singapore-expo',
    'Hong Kong':   'hk-aws',
    'Sydney':      'sydney-icc',
    'Melbourne':   'melbourne-mcec',
    'Dubai':       'dubai-wtc',
    'Mexico City': 'mexico-city-exh',
    'Toronto':     'toronto-mtcc',
    'São Paulo':   'sao-paulo-trans',
    'Cape Town':   'cape-town-ctcc',
  };
  return overrides[ev.city];
}
