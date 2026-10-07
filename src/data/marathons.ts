import type { Marathon } from '@/types/onboarding';
import { MARATHON_COURSE_PROFILES } from './marathon-course-profiles';
import { withNextEdition } from './race-calendar';

/** Attach the static course profile (if any) to a marathon entry. */
function attachProfile(m: Marathon): Marathon {
  const profile = MARATHON_COURSE_PROFILES[m.id];
  return profile ? { ...m, profile } : m;
}

/**
 * World marathon and half marathon database.
 * Curated dates; once a date passes, the getters below project the next
 * edition (race-calendar.ts) so the picker never runs dry. Refreshing a date
 * here replaces the estimate with the confirmed one.
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
  {
    id: 'copenhagen-marathon',
    name: 'Copenhagen Marathon',
    city: 'Copenhagen',
    country: 'Denmark',
    date: '2026-05-17',
    distance: 'marathon',
  },
  {
    id: 'stockholm-marathon',
    name: 'Stockholm Marathon',
    city: 'Stockholm',
    country: 'Sweden',
    date: '2026-05-30',
    distance: 'marathon',
  },
  {
    id: 'helsinki-marathon',
    name: 'Helsinki City Marathon',
    city: 'Helsinki',
    country: 'Finland',
    date: '2026-08-22',
    distance: 'marathon',
  },
  {
    id: 'reykjavik-marathon',
    name: 'Reykjavík Marathon',
    city: 'Reykjavík',
    country: 'Iceland',
    date: '2026-08-22',
    distance: 'marathon',
  },
  {
    id: 'frankfurt-marathon',
    name: 'Frankfurt Marathon',
    city: 'Frankfurt',
    country: 'Germany',
    date: '2026-10-25',
    distance: 'marathon',
  },
  {
    id: 'dublin-marathon',
    name: 'Dublin Marathon',
    city: 'Dublin',
    country: 'Ireland',
    date: '2026-10-25',
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

  // May–August halfs (fill the gap between spring and autumn)
  {
    id: 'leeds-half',
    name: 'Rob Burrow Leeds Half',
    city: 'Leeds',
    country: 'United Kingdom',
    date: '2026-05-10',
    distance: 'half',
  },
  {
    id: 'hackney-half',
    name: 'Hackney Half',
    city: 'London',
    country: 'United Kingdom',
    date: '2026-05-17',
    distance: 'half',
  },
  {
    id: 'edinburgh-half',
    name: 'Edinburgh Half Marathon',
    city: 'Edinburgh',
    country: 'United Kingdom',
    date: '2026-05-24',
    distance: 'half',
  },
  {
    id: 'liverpool-half',
    name: 'Liverpool Rock n Roll Half',
    city: 'Liverpool',
    country: 'United Kingdom',
    date: '2026-05-31',
    distance: 'half',
  },
  {
    id: 'oslo-half',
    name: 'Oslo Half Marathon',
    city: 'Oslo',
    country: 'Norway',
    date: '2026-06-13',
    distance: 'half',
  },
  {
    id: 'helsinki-half',
    name: 'Helsinki Half Marathon',
    city: 'Helsinki',
    country: 'Finland',
    date: '2026-06-20',
    distance: 'half',
  },
  {
    id: 'brighton-marathon-half-relay',
    name: 'Sandown Half',
    city: 'Esher',
    country: 'United Kingdom',
    date: '2026-07-05',
    distance: 'half',
  },
  {
    id: 'reykjavik-half',
    name: 'Reykjavík Half',
    city: 'Reykjavík',
    country: 'Iceland',
    date: '2026-08-22',
    distance: 'half',
  },
  {
    id: 'bristol-half',
    name: 'Bristol Half Marathon',
    city: 'Bristol',
    country: 'United Kingdom',
    date: '2026-09-13',
    distance: 'half',
  },
  {
    id: 'nottingham-half',
    name: 'Robin Hood Half Marathon',
    city: 'Nottingham',
    country: 'United Kingdom',
    date: '2026-09-27',
    distance: 'half',
  },
];

/**
 * A race date as a local calendar date. A bare YYYY-MM-DD is built from its
 * parts: `new Date('2026-11-15')` is UTC midnight, which west of UTC is the
 * previous evening, so a race tomorrow read as today (and displayed a day
 * early) in New York or Los Angeles.
 */
function parseRaceDate(dateString: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(dateString);
}

/**
 * Weeks until a race from today: ceil(calendar days / 7). A rough count for
 * lists and sorting; a plan's length comes from the calendar weeks it spans
 * (raceWeekLayout, workouts/race-week-layout.ts).
 */
export function calculateWeeksUntil(dateString: string): number {
  return Math.ceil(calculateDaysUntil(dateString) / 7);
}

/** Calendar days from today to a race date. Negative = past, 0 = today, 1 = tomorrow. */
export function calculateDaysUntil(dateString: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const raceDate = parseRaceDate(dateString);
  raceDate.setHours(0, 0, 0, 0);
  return Math.round((raceDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Human-friendly proximity label for a race date.
 * Shows days when within a week (so "Tomorrow" / "3d" doesn't read as "1wk"),
 * weeks otherwise. Returns null for races already in the past.
 */
export function formatTimeUntil(dateString: string): string | null {
  const days = calculateDaysUntil(dateString);
  if (days < 0) return null;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `${days}d`;
  return `${Math.round(days / 7)}wk`;
}

/** True if the race date is today or in the future (uses local-date comparison). */
export function isUpcoming(dateString: string): boolean {
  return calculateDaysUntil(dateString) >= 0;
}

/**
 * Get marathons or half marathons filtered by distance and sorted by date.
 * Returns events from `minWeeks` to `maxWeeks` away (default: at least 8
 * weeks), never today's or a past race. The running race page passes 0 so
 * near races are listed too (a sharpening block, Tristan 2026-10-05).
 */
export function getMarathonsByDistance(
  distance: 'half' | 'marathon',
  minWeeks: number = 8,
  maxWeeks: number = Infinity,
): Marathon[] {
  return WORLD_MARATHONS
    .filter(m => m.distance === distance)
    .map(m => withNextEdition(m))
    .map(m => attachProfile({
      ...m,
      weeksUntil: calculateWeeksUntil(m.date),
    }))
    .filter(m => m.weeksUntil !== undefined && m.weeksUntil >= minWeeks && m.weeksUntil <= maxWeeks)
    .filter(m => calculateDaysUntil(m.date) >= 1)
    .sort((a, b) => calculateDaysUntil(a.date) - calculateDaysUntil(b.date));
}

/**
 * Get all upcoming races sorted by date
 */
export function getAllUpcomingRaces(minWeeks: number = 8): Marathon[] {
  return WORLD_MARATHONS
    .map(m => withNextEdition(m))
    .map(m => attachProfile({
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
  const found = WORLD_MARATHONS.find(m => m.id === id);
  const marathon = found ? withNextEdition(found) : undefined;
  if (marathon) {
    return attachProfile({
      ...marathon,
      weeksUntil: calculateWeeksUntil(marathon.date),
    });
  }
  return undefined;
}

/**
 * Format a date for display
 */
export function formatRaceDate(dateString: string): string {
  const date = parseRaceDate(dateString);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
