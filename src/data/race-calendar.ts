/**
 * Annual roll-forward for recurring race calendars (marathons, halves, triathlons).
 *
 * The curated race lists carry one confirmed date per event. Once that date
 * passes, the event would drop out of the picker until someone edits the file,
 * so the list shrinks through the year. Instead, a passed event is projected to
 * its next edition using the same weekday-of-month rule it ran on
 * (e.g. Berlin 2026-09-27 = last Sunday of September → 2027-09-26;
 * Chicago = 2nd Sunday of October; Boston = 3rd Monday of April).
 *
 * Projected dates are flagged `estimated: true` so the UI can say so. Once a
 * picked race is stored on state its date is frozen, so a later refresh of the
 * curated list never moves a plan that has already been built.
 *
 * HYROX is deliberately NOT rolled forward: venues and months move between
 * seasons, so HYROX only lists confirmed dates (decided 2026-09-28).
 */

/** Caption shown under a picked race whose date is projected. */
export const ESTIMATED_DATE_NOTE = 'Estimated from last year\'s date. Confirm on the race website before relying on it.';

export interface RolledDate {
  date: string;        // ISO YYYY-MM-DD
  estimated: boolean;  // true when projected past the curated date
}

function parseISO(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The same weekday-of-month slot in another year. An event in the last 7 days
 * of its month is treated as "last <weekday>", otherwise as the nth weekday.
 */
export function sameWeekdaySlotInYear(iso: string, year: number): string {
  const { y, m, d } = parseISO(iso);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const isLast = d + 7 > daysInMonth(y, m);
  const nth = Math.ceil(d / 7);

  const dim = daysInMonth(year, m);
  if (isLast) {
    const lastWeekday = new Date(Date.UTC(year, m - 1, dim)).getUTCDay();
    return toISO(year, m, dim - ((lastWeekday - weekday + 7) % 7));
  }
  const firstWeekday = new Date(Date.UTC(year, m - 1, 1)).getUTCDay();
  const firstMatch = 1 + ((weekday - firstWeekday + 7) % 7);
  return toISO(year, m, firstMatch + (nth - 1) * 7);
}

/** Local today as ISO, matching calculateDaysUntil's local-date comparison. */
function todayISO(): string {
  const t = new Date();
  return toISO(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/**
 * Next occurrence of a recurring race on or after `today`. Returns the curated
 * date untouched when it is still upcoming.
 */
export function nextEditionDate(iso: string, today: string = todayISO()): RolledDate {
  if (iso.slice(0, 10) >= today) return { date: iso, estimated: false };
  const { y } = parseISO(iso);
  const todayYear = parseISO(today).y;
  for (let year = Math.max(y + 1, todayYear); year <= todayYear + 1; year++) {
    const projected = sameWeekdaySlotInYear(iso, year);
    if (projected >= today) return { date: projected, estimated: true };
  }
  // Unreachable: todayYear + 1 always lands after today.
  return { date: sameWeekdaySlotInYear(iso, todayYear + 1), estimated: true };
}

/** Apply the roll-forward to a race entry, preserving every other field. */
export function withNextEdition<T extends { date: string }>(race: T, today?: string): T & { estimated?: boolean } {
  const { date, estimated } = nextEditionDate(race.date, today);
  return estimated ? { ...race, date, estimated } : race;
}
