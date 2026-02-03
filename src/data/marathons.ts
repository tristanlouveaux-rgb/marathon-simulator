import type { Marathon } from '@/types/onboarding';

/**
 * World marathon and half marathon database
 * Dates are approximate and should be updated annually
 */
export const WORLD_MARATHONS: Marathon[] = [
  // World Marathon Majors
  {
    id: 'london',
    name: 'London Marathon',
    city: 'London',
    country: 'United Kingdom',
    date: '2026-04-26',
    distance: 'marathon',
  },
  {
    id: 'berlin',
    name: 'Berlin Marathon',
    city: 'Berlin',
    country: 'Germany',
    date: '2026-09-27',
    distance: 'marathon',
  },
  {
    id: 'chicago',
    name: 'Chicago Marathon',
    city: 'Chicago',
    country: 'USA',
    date: '2026-10-11',
    distance: 'marathon',
  },
  {
    id: 'nyc',
    name: 'New York City Marathon',
    city: 'New York',
    country: 'USA',
    date: '2026-11-01',
    distance: 'marathon',
  },
  {
    id: 'tokyo',
    name: 'Tokyo Marathon',
    city: 'Tokyo',
    country: 'Japan',
    date: '2027-03-07',
    distance: 'marathon',
  },
  {
    id: 'boston',
    name: 'Boston Marathon',
    city: 'Boston',
    country: 'USA',
    date: '2026-04-20',
    distance: 'marathon',
  },

  // Other Major Marathons
  {
    id: 'paris',
    name: 'Paris Marathon',
    city: 'Paris',
    country: 'France',
    date: '2026-04-05',
    distance: 'marathon',
  },
  {
    id: 'amsterdam',
    name: 'Amsterdam Marathon',
    city: 'Amsterdam',
    country: 'Netherlands',
    date: '2026-10-18',
    distance: 'marathon',
  },
  {
    id: 'sydney',
    name: 'Sydney Marathon',
    city: 'Sydney',
    country: 'Australia',
    date: '2026-09-20',
    distance: 'marathon',
  },
  {
    id: 'melbourne',
    name: 'Melbourne Marathon',
    city: 'Melbourne',
    country: 'Australia',
    date: '2026-10-11',
    distance: 'marathon',
  },
  {
    id: 'dubai',
    name: 'Dubai Marathon',
    city: 'Dubai',
    country: 'UAE',
    date: '2027-01-08',
    distance: 'marathon',
  },
  {
    id: 'seoul',
    name: 'Seoul Marathon',
    city: 'Seoul',
    country: 'South Korea',
    date: '2026-03-15',
    distance: 'marathon',
  },
  {
    id: 'valencia',
    name: 'Valencia Marathon',
    city: 'Valencia',
    country: 'Spain',
    date: '2026-12-06',
    distance: 'marathon',
  },
  {
    id: 'barcelona',
    name: 'Barcelona Marathon',
    city: 'Barcelona',
    country: 'Spain',
    date: '2026-03-08',
    distance: 'marathon',
  },
  {
    id: 'rome',
    name: 'Rome Marathon',
    city: 'Rome',
    country: 'Italy',
    date: '2026-03-22',
    distance: 'marathon',
  },
  {
    id: 'toronto',
    name: 'Toronto Marathon',
    city: 'Toronto',
    country: 'Canada',
    date: '2026-05-03',
    distance: 'marathon',
  },
  {
    id: 'manchester',
    name: 'Manchester Marathon',
    city: 'Manchester',
    country: 'United Kingdom',
    date: '2026-04-19',
    distance: 'marathon',
  },
  {
    id: 'edinburgh',
    name: 'Edinburgh Marathon',
    city: 'Edinburgh',
    country: 'United Kingdom',
    date: '2026-05-24',
    distance: 'marathon',
  },

  // Major Half Marathons
  {
    id: 'great-north',
    name: 'Great North Run',
    city: 'Newcastle',
    country: 'United Kingdom',
    date: '2026-09-13',
    distance: 'half',
  },
  {
    id: 'nyc-half',
    name: 'NYC Half Marathon',
    city: 'New York',
    country: 'USA',
    date: '2026-03-15',
    distance: 'half',
  },
  {
    id: 'big-half',
    name: 'The Big Half',
    city: 'London',
    country: 'United Kingdom',
    date: '2026-09-06',
    distance: 'half',
  },
  {
    id: 'lisbon-half',
    name: 'Lisbon Half Marathon',
    city: 'Lisbon',
    country: 'Portugal',
    date: '2026-03-22',
    distance: 'half',
  },
  {
    id: 'copenhagen-half',
    name: 'Copenhagen Half Marathon',
    city: 'Copenhagen',
    country: 'Denmark',
    date: '2026-09-20',
    distance: 'half',
  },
  {
    id: 'delhi-half',
    name: 'Delhi Half Marathon',
    city: 'Delhi',
    country: 'India',
    date: '2026-10-18',
    distance: 'half',
  },
  {
    id: 'cardiff-half',
    name: 'Cardiff Half Marathon',
    city: 'Cardiff',
    country: 'United Kingdom',
    date: '2026-10-04',
    distance: 'half',
  },
  {
    id: 'berlin-half',
    name: 'Berlin Half Marathon',
    city: 'Berlin',
    country: 'Germany',
    date: '2026-04-05',
    distance: 'half',
  },
];

/**
 * Calculate weeks until a race from today
 */
export function calculateWeeksUntil(dateString: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const raceDate = new Date(dateString);
  const diffMs = raceDate.getTime() - today.getTime();
  const diffWeeks = Math.ceil(diffMs / (7 * 24 * 60 * 60 * 1000));
  return diffWeeks;
}

/**
 * Get marathons or half marathons filtered by distance and sorted by date
 * Only returns events at least minWeeks away (default 8 weeks)
 */
export function getMarathonsByDistance(
  distance: 'half' | 'marathon',
  minWeeks: number = 8
): Marathon[] {
  return WORLD_MARATHONS
    .filter(m => m.distance === distance)
    .map(m => ({
      ...m,
      weeksUntil: calculateWeeksUntil(m.date),
    }))
    .filter(m => m.weeksUntil !== undefined && m.weeksUntil >= minWeeks)
    .sort((a, b) => (a.weeksUntil ?? 0) - (b.weeksUntil ?? 0));
}

/**
 * Get all upcoming races sorted by date
 */
export function getAllUpcomingRaces(minWeeks: number = 8): Marathon[] {
  return WORLD_MARATHONS
    .map(m => ({
      ...m,
      weeksUntil: calculateWeeksUntil(m.date),
    }))
    .filter(m => m.weeksUntil !== undefined && m.weeksUntil >= minWeeks)
    .sort((a, b) => (a.weeksUntil ?? 0) - (b.weeksUntil ?? 0));
}

/**
 * Find a marathon by ID
 */
export function getMarathonById(id: string): Marathon | undefined {
  const marathon = WORLD_MARATHONS.find(m => m.id === id);
  if (marathon) {
    return {
      ...marathon,
      weeksUntil: calculateWeeksUntil(marathon.date),
    };
  }
  return undefined;
}

/**
 * Format a date for display
 */
export function formatRaceDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
