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
