import type { Triathlon } from '@/types/onboarding';
import { calculateWeeksUntil } from '@/data/marathons';
import { COURSE_PROFILES } from '@/data/triathlon-course-profiles';

/**
 * IRONMAN-branded race calendar (full 140.6 and 70.3).
 * Dates sourced from official 2026 schedules — refresh annually.
 */
export const WORLD_TRIATHLONS: Triathlon[] = [
  // ── IRONMAN (full distance, 140.6) ────────────────────────────────────
  { id: 'im-new-zealand',     name: 'IRONMAN New Zealand',                 city: 'Taupō',             country: 'New Zealand',   date: '2026-03-07', distance: 'ironman' },
  { id: 'im-penghu',          name: 'IRONMAN Penghu',                      city: 'Penghu',            country: 'Chinese Taipei',date: '2026-04-12', distance: 'ironman' },
  { id: 'im-texas',           name: 'IRONMAN Texas',                       city: 'The Woodlands',     country: 'USA',           date: '2026-04-18', distance: 'ironman' },
  { id: 'im-south-africa',    name: 'IRONMAN South Africa',                city: 'Nelson Mandela Bay',country: 'South Africa',  date: '2026-04-19', distance: 'ironman' },
  { id: 'im-vietnam',         name: 'IRONMAN Vietnam',                     city: 'Da Nang',           country: 'Vietnam',       date: '2026-05-10', distance: 'ironman' },
  { id: 'im-jacksonville',    name: 'IRONMAN Jacksonville',                city: 'Jacksonville',      country: 'USA',           date: '2026-05-16', distance: 'ironman' },
  { id: 'im-lanzarote',       name: 'IRONMAN Lanzarote',                   city: 'Lanzarote',         country: 'Spain',         date: '2026-05-23', distance: 'ironman' },
  { id: 'im-brazil',          name: 'IRONMAN Brazil',                      city: 'Florianópolis',     country: 'Brazil',        date: '2026-05-31', distance: 'ironman' },
  { id: 'im-hamburg',         name: 'IRONMAN Hamburg',                     city: 'Hamburg',           country: 'Germany',       date: '2026-06-07', distance: 'ironman' },
  { id: 'im-subic-bay',       name: 'IRONMAN Subic Bay',                   city: 'Subic Bay',         country: 'Philippines',   date: '2026-06-07', distance: 'ironman' },
  { id: 'im-cairns',          name: 'IRONMAN Cairns',                      city: 'Cairns',            country: 'Australia',     date: '2026-06-14', distance: 'ironman' },
  { id: 'im-klagenfurt',      name: 'IRONMAN Kärnten-Klagenfurt',          city: 'Klagenfurt',        country: 'Austria',       date: '2026-06-14', distance: 'ironman' },
  { id: 'im-tours',           name: 'IRONMAN Tours Métropole',             city: 'Tours',             country: 'France',        date: '2026-06-14', distance: 'ironman' },
  { id: 'im-france',          name: 'IRONMAN France Nice',                 city: 'Nice',              country: 'France',        date: '2026-06-28', distance: 'ironman' },
  { id: 'im-frankfurt',       name: 'IRONMAN Frankfurt',                   city: 'Frankfurt',         country: 'Germany',       date: '2026-06-28', distance: 'ironman' },
  { id: 'im-switzerland',     name: 'IRONMAN Switzerland Thun',            city: 'Thun',              country: 'Switzerland',   date: '2026-07-05', distance: 'ironman' },
  { id: 'im-vitoria',         name: 'IRONMAN Vitoria-Gasteiz',             city: 'Vitoria-Gasteiz',   country: 'Spain',         date: '2026-07-12', distance: 'ironman' },
  { id: 'im-lake-placid',     name: 'IRONMAN Lake Placid',                 city: 'Lake Placid',       country: 'USA',           date: '2026-07-19', distance: 'ironman' },
  { id: 'im-canada-ottawa',   name: 'IRONMAN Canada-Ottawa',               city: 'Ottawa',            country: 'Canada',        date: '2026-08-02', distance: 'ironman' },
  { id: 'im-kalmar',          name: 'IRONMAN Kalmar',                      city: 'Kalmar',            country: 'Sweden',        date: '2026-08-15', distance: 'ironman' },
  { id: 'im-leeds',           name: 'IRONMAN Leeds',                       city: 'Leeds',             country: 'United Kingdom',date: '2026-08-16', distance: 'ironman' },
  { id: 'im-copenhagen',      name: 'IRONMAN Copenhagen',                  city: 'Copenhagen',        country: 'Denmark',       date: '2026-08-16', distance: 'ironman' },
  { id: 'im-tallinn',         name: 'IRONMAN Tallinn',                     city: 'Tallinn',           country: 'Estonia',       date: '2026-08-22', distance: 'ironman' },
  { id: 'im-vichy',           name: 'IRONMAN Vichy',                       city: 'Vichy',             country: 'France',        date: '2026-08-23', distance: 'ironman' },
  { id: 'im-wales',           name: 'IRONMAN Wales',                       city: 'Tenby',             country: 'United Kingdom',date: '2026-09-13', distance: 'ironman' },
  { id: 'im-wisconsin',       name: 'IRONMAN Wisconsin',                   city: 'Madison',           country: 'USA',           date: '2026-09-13', distance: 'ironman' },
  { id: 'im-japan-hokkaido',  name: 'IRONMAN Japan South Hokkaido',        city: 'Hokkaido',          country: 'Japan',         date: '2026-09-13', distance: 'ironman' },
  { id: 'im-italy',           name: 'IRONMAN Italy Emilia-Romagna',        city: 'Cervia',            country: 'Italy',         date: '2026-09-19', distance: 'ironman' },
  { id: 'im-maryland',        name: 'IRONMAN Maryland',                    city: 'Cambridge',         country: 'USA',           date: '2026-09-19', distance: 'ironman' },
  { id: 'im-chattanooga',     name: 'IRONMAN Chattanooga',                 city: 'Chattanooga',       country: 'USA',           date: '2026-09-27', distance: 'ironman' },
  { id: 'im-barcelona',       name: 'IRONMAN Barcelona',                   city: 'Calella',           country: 'Spain',         date: '2026-10-04', distance: 'ironman' },
  { id: 'im-gurye',           name: 'IRONMAN Gurye Korea',                 city: 'Gurye',             country: 'South Korea',   date: '2026-10-04', distance: 'ironman' },
  { id: 'im-kona',            name: 'IRONMAN World Championship',          city: 'Kailua-Kona',       country: 'USA',           date: '2026-10-10', distance: 'ironman' },
  { id: 'im-cascais',         name: 'IRONMAN Portugal-Cascais',            city: 'Cascais',           country: 'Portugal',      date: '2026-10-17', distance: 'ironman' },
  { id: 'im-california',      name: 'IRONMAN California',                  city: 'Sacramento',        country: 'USA',           date: '2026-10-18', distance: 'ironman' },
  { id: 'im-australia',       name: 'IRONMAN Australia',                   city: 'Port Macquarie',    country: 'Australia',     date: '2026-10-18', distance: 'ironman' },
  { id: 'im-san-juan',        name: 'IRONMAN San Juan',                    city: 'San Juan',          country: 'Argentina',     date: '2026-11-01', distance: 'ironman' },
  { id: 'im-florida',         name: 'IRONMAN Florida',                     city: 'Panama City Beach', country: 'USA',           date: '2026-11-07', distance: 'ironman' },
  { id: 'im-malaysia',        name: 'IRONMAN Malaysia',                    city: 'Langkawi',          country: 'Malaysia',      date: '2026-11-21', distance: 'ironman' },
  { id: 'im-cozumel',         name: 'IRONMAN Cozumel',                     city: 'Cozumel',           country: 'Mexico',        date: '2026-11-22', distance: 'ironman' },
  { id: 'im-valdivia',        name: 'IRONMAN Valdivia',                    city: 'Valdivia',          country: 'Chile',         date: '2026-11-29', distance: 'ironman' },
  { id: 'im-oman',            name: 'IRONMAN Oman',                        city: 'Muscat',            country: 'Oman',          date: '2026-12-05', distance: 'ironman' },
  { id: 'im-western-australia',name:'IRONMAN Western Australia',           city: 'Busselton',         country: 'Australia',     date: '2026-12-06', distance: 'ironman' },

  // ── IRONMAN 70.3 (half distance) ──────────────────────────────────────
  { id: '703-dallas',         name: 'IRONMAN 70.3 Dallas-Little Elm',      city: 'Dallas',            country: 'USA',           date: '2026-03-15', distance: '70.3' },
  { id: '703-geelong',        name: 'IRONMAN 70.3 Geelong',                city: 'Geelong',           country: 'Australia',     date: '2026-03-22', distance: '70.3' },
  { id: '703-oceanside',      name: 'IRONMAN 70.3 Oceanside',              city: 'Oceanside',         country: 'USA',           date: '2026-03-28', distance: '70.3' },
  { id: '703-valencia',       name: 'IRONMAN 70.3 Valencia',               city: 'Valencia',          country: 'Spain',         date: '2026-04-19', distance: '70.3' },
  { id: '703-venice-jesolo',  name: 'IRONMAN 70.3 Venice-Jesolo',          city: 'Jesolo',            country: 'Italy',         date: '2026-05-03', distance: '70.3' },
  { id: '703-mallorca',       name: 'IRONMAN 70.3 Mallorca',               city: 'Alcúdia',           country: 'Spain',         date: '2026-05-09', distance: '70.3' },
  { id: '703-gulf-coast',     name: 'IRONMAN 70.3 Gulf Coast',             city: 'Panama City Beach', country: 'USA',           date: '2026-05-09', distance: '70.3' },
  { id: '703-aix',            name: 'IRONMAN 70.3 Aix-en-Provence',        city: 'Aix-en-Provence',   country: 'France',        date: '2026-05-17', distance: '70.3' },
  { id: '703-kraichgau',      name: 'IRONMAN 70.3 Kraichgau',              city: 'Kraichgau',         country: 'Germany',       date: '2026-05-31', distance: '70.3' },
  { id: '703-bolton',         name: 'IRONMAN 70.3 Bolton',                 city: 'Bolton',            country: 'United Kingdom',date: '2026-06-07', distance: '70.3' },
  { id: '703-switzerland',    name: 'IRONMAN 70.3 Switzerland',            city: 'Rapperswil-Jona',   country: 'Switzerland',   date: '2026-06-07', distance: '70.3' },
  { id: '703-omaha',          name: 'IRONMAN 70.3 Omaha',                  city: 'Omaha',             country: 'USA',           date: '2026-06-07', distance: '70.3' },
  { id: '703-eagleman',       name: 'IRONMAN 70.3 Eagleman',               city: 'Cambridge',         country: 'USA',           date: '2026-06-14', distance: '70.3' },
  { id: '703-happy-valley',   name: 'IRONMAN 70.3 Pennsylvania Happy Valley',city:'State College',   country: 'USA',           date: '2026-06-14', distance: '70.3' },
  { id: '703-westfriesland',  name: 'IRONMAN 70.3 Westfriesland',          city: 'Hoorn',             country: 'Netherlands',   date: '2026-06-21', distance: '70.3' },
  { id: '703-elsinore',       name: 'IRONMAN 70.3 Elsinore',               city: 'Elsinore',          country: 'Denmark',       date: '2026-06-21', distance: '70.3' },
  { id: '703-tallinn',        name: 'IRONMAN 70.3 Tallinn',                city: 'Tallinn',           country: 'Estonia',       date: '2026-06-23', distance: '70.3' },
  { id: '703-nice',           name: 'IRONMAN 70.3 Nice',                   city: 'Nice',              country: 'France',        date: '2026-06-28', distance: '70.3' },
  { id: '703-jonkoping',      name: 'IRONMAN 70.3 Jönköping (European Champs)', city:'Jönköping',    country: 'Sweden',        date: '2026-07-05', distance: '70.3' },
  { id: '703-vendee',         name: "IRONMAN 70.3 Les Sables d'Olonne",    city: 'Vendée',            country: 'France',        date: '2026-07-05', distance: '70.3' },
  { id: '703-ruidoso',        name: 'IRONMAN 70.3 Ruidoso',                city: 'Ruidoso',           country: 'USA',           date: '2026-07-12', distance: '70.3' },
  { id: '703-vitoria',        name: 'IRONMAN 70.3 Vitoria-Gasteiz',        city: 'Vitoria-Gasteiz',   country: 'Spain',         date: '2026-07-12', distance: '70.3' },
  { id: '703-luxembourg',     name: 'IRONMAN 70.3 Luxembourg',             city: 'Remich',            country: 'Luxembourg',    date: '2026-07-12', distance: '70.3' },
  { id: '703-swansea',        name: 'IRONMAN 70.3 Swansea',                city: 'Swansea',           country: 'United Kingdom',date: '2026-07-12', distance: '70.3' },
  { id: '703-ohio',           name: 'IRONMAN 70.3 Ohio',                   city: 'Sandusky',          country: 'USA',           date: '2026-07-16', distance: '70.3' },
  { id: '703-oregon',         name: 'IRONMAN 70.3 Oregon',                 city: 'Salem',             country: 'USA',           date: '2026-07-19', distance: '70.3' },
  { id: '703-boise',          name: 'IRONMAN 70.3 Boise',                  city: 'Boise',             country: 'USA',           date: '2026-07-25', distance: '70.3' },
  { id: '703-norcal',         name: 'IRONMAN 70.3 Northern California',    city: 'Redding',           country: 'USA',           date: '2026-08-16', distance: '70.3' },
  { id: '703-duisburg',       name: 'IRONMAN 70.3 Duisburg',               city: 'Duisburg',          country: 'Germany',       date: '2026-08-23', distance: '70.3' },
  { id: '703-zell-am-see',    name: 'IRONMAN 70.3 Zell am See-Kaprun',     city: 'Zell am See',       country: 'Austria',       date: '2026-08-30', distance: '70.3' },
  { id: '703-worlds',         name: 'IRONMAN 70.3 World Championship',     city: 'Nice',              country: 'France',        date: '2026-09-12', distance: '70.3' },
  { id: '703-michigan',       name: 'IRONMAN 70.3 Michigan',               city: 'Frankfort',         country: 'USA',           date: '2026-09-20', distance: '70.3' },
  { id: '703-emilia-romagna', name: 'IRONMAN 70.3 Emilia-Romagna',         city: 'Cervia',            country: 'Italy',         date: '2026-09-20', distance: '70.3' },
  { id: '703-augusta',        name: 'IRONMAN 70.3 Augusta',                city: 'Augusta',           country: 'USA',           date: '2026-09-27', distance: '70.3' },
  { id: '703-malaga',         name: 'IRONMAN 70.3 Málaga',                 city: 'Málaga',            country: 'Spain',         date: '2026-10-18', distance: '70.3' },
  { id: '703-porec',          name: 'IRONMAN 70.3 Poreč',                  city: 'Poreč',             country: 'Croatia',       date: '2026-10-18', distance: '70.3' },
];

function attachProfile(t: Triathlon): Triathlon {
  const profile = COURSE_PROFILES[t.id];
  return profile ? { ...t, profile } : t;
}

/** Filter triathlons by IRONMAN distance and minimum weeks-until cutoff. */
export function getTriathlonsByDistance(
  distance: '70.3' | 'ironman',
  minWeeks: number = 8,
): Triathlon[] {
  return WORLD_TRIATHLONS
    .filter(t => t.distance === distance)
    .map(t => attachProfile({ ...t, weeksUntil: calculateWeeksUntil(t.date) }))
    .filter(t => t.weeksUntil !== undefined && t.weeksUntil >= minWeeks)
    .sort((a, b) => (a.weeksUntil ?? 0) - (b.weeksUntil ?? 0));
}

export function getTriathlonById(id: string): Triathlon | undefined {
  const t = WORLD_TRIATHLONS.find(r => r.id === id);
  return t ? attachProfile({ ...t, weeksUntil: calculateWeeksUntil(t.date) }) : undefined;
}
