/**
 * Local-calendar date keys.
 *
 * HealthKit (through the HealthExtras plugin) serialises every timestamp as a
 * GMT ISO string ending in "Z". `iso.split('T')[0]` on such a string gives the
 * UTC date, which is the wrong calendar day for anyone off UTC: in UTC+ zones
 * morning samples land on the previous day, and in UTC- zones evening samples
 * land on the next day. Garmin's `calendarDate` is the device-local date, so
 * keying Apple samples locally also puts both sources for one day on one key.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * YYYY-MM-DD for the instant `input`, in the device's local time zone.
 *
 * - A `Date` or a full ISO timestamp is converted to the local calendar date.
 * - A bare date string ("2026-10-01") is already a calendar key and is returned
 *   unchanged. `new Date('2026-10-01')` would read it as UTC midnight and shift
 *   it back a day in UTC- zones.
 * - Returns '' when the input cannot be parsed, so callers can skip the sample.
 */
export function localDateKey(input: Date | string): string {
  if (typeof input === 'string' && DATE_ONLY.test(input)) return input;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * True when the instant `startTime` (an activity's ISO start) falls on the local
 * calendar day `day` (YYYY-MM-DD). The single rule for "which day does this
 * activity belong to": synced activities are filed by the athlete's local day,
 * the same calendar plan weekdays use. `startTime.startsWith(day)` compared the
 * UTC day, so a late-evening session west of UTC or an early-morning one east
 * of UTC landed on the neighbouring day.
 */
export function isOnLocalDay(startTime: string | null | undefined, day: string): startTime is string {
  return !!startTime && localDateKey(startTime) === day;
}

/**
 * YYYY-MM-DD of the Monday on or before the instant's local calendar day: the
 * calendar week an activity belongs to. Calendar arithmetic runs on the date
 * components at UTC midnight, so no DST shift can move it.
 */
export function localMondayKey(input: Date | string): string {
  const key = localDateKey(input);
  if (!key) return '';
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const dow = day.getUTCDay(); // 0 = Sunday
  day.setUTCDate(day.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return day.toISOString().slice(0, 10);
}

/**
 * Whole calendar days from local day `fromKey` to local day `toKey`
 * (YYYY-MM-DD each), e.g. 7 from a Monday to the next Monday. NaN when either
 * key is malformed.
 */
export function calendarDaysBetween(fromKey: string, toKey: string): number {
  const parse = (k: string): number => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(toKey) - parse(fromKey)) / 86400000);
}

/**
 * Local midnight that starts plan week `weekNum` (1-based) for a plan starting
 * on local day `planStartDate` (YYYY-MM-DD). `new Date('YYYY-MM-DD')` reads UTC
 * midnight, which is not the start of the athlete's day anywhere off UTC.
 */
export function localMidnightOfPlanWeek(planStartDate: string, weekNum: number): Date {
  const [y, m, d] = localDateKey(planStartDate).split('-').map(Number);
  return new Date(y, m - 1, d + (weekNum - 1) * 7, 0, 0, 0, 0);
}
