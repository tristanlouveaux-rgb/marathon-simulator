/**
 * Multi-sport scheduler for triathlon weeks.
 *
 * Constraint rules (§18.8):
 *   - Long run → Sunday, long bike or brick → Saturday
 *   - Respect weekday hour cap: Mon–Fri combined must fit the user's
 *     available weekday hours (e.g. 9-to-5 users can only spare ~1h/day)
 *   - Quality sessions (threshold / VO2) spread across the week — no two
 *     hard same-discipline sessions on consecutive days
 *   - Swim threshold mid-week (Wed) to separate from bike/run quality
 *   - Never double up the SAME discipline on the same day unless it's an
 *     explicit two-a-day (e.g. PM swim after AM run in peak phases)
 *
 * Output: sets `dayOfWeek` (0=Mon..6=Sun) and `dayName` on every workout.
 */

import type { Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Preferred day order per discipline (0=Mon..6=Sun).
// Picks spread across the week with a rest-friendly Monday.
const SWIM_DAYS = [1, 2, 4, 0, 3];        // Tue, Wed, Fri, Mon, Thu
const BIKE_DAYS = [1, 3, 4];              // Tue, Thu, Fri (Saturday reserved for long bike / brick)
const RUN_DAYS  = [2, 3, 1, 4, 0];        // Wed, Thu, Tue, Fri, Mon (Sunday reserved for long run)

export const WEEKDAY_INDEXES = [0, 1, 2, 3, 4];  // Mon–Fri
export const WEEKEND_INDEXES = [5, 6];           // Sat–Sun

/**
 * Assign workouts to days. Input is a flat list of per-discipline workouts
 * (already generated with type + load). We tag each with dayOfWeek/dayName
 * and return them in day order.
 */
export function scheduleTriathlonWeek(
  swim: Workout[],
  bike: Workout[],
  run: Workout[],
  brick: Workout | null,
  phase: TrainingPhase,
  gym: Workout[] = [],
  /** Per-day minute cap by day-of-week. When a day's budget is exhausted,
   * sessions are pushed to the next-best day. Undefined = no cap. */
  minutesCapByDay?: Record<number, number>
): Workout[] {
  const byDay: Record<number, Workout[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const minutesOnDay: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

  // Track which disciplines are already on each day so we avoid same-
  // discipline doubles unless we really have to.
  const occupiedDisciplines: Record<number, Set<string>> = {
    0: new Set(), 1: new Set(), 2: new Set(), 3: new Set(),
    4: new Set(), 5: new Set(), 6: new Set(),
  };
  const place = (day: number, w: Workout) => {
    byDay[day].push(w);
    minutesOnDay[day] += workoutMinutes(w);
    occupiedDisciplines[day].add(w.discipline ?? 'run');
  };

  const hasCapacity = (day: number, w: Workout): boolean => {
    if (!minutesCapByDay) return true;
    const cap = minutesCapByDay[day];
    if (cap === undefined) return true;
    return minutesOnDay[day] + workoutMinutes(w) <= cap + 15;  // 15 min tolerance
  };

  // 1. Long session Saturday — brick replaces the long bike if present.
  if (brick) {
    place(5, brick);
  } else {
    // Longest bike (last in array by convention) → Saturday
    if (bike.length > 0) {
      const longBike = bike.pop()!;
      place(5, longBike);
    }
  }

  // 2. Long run → Sunday (last run in the array by convention).
  if (run.length > 0) {
    const longRun = run.pop()!;
    place(6, longRun);
  }

  // 3. Gym → Monday + Friday (off-run days).
  if (gym.length > 0) place(0, gym[0]);
  if (gym.length > 1) place(4, gym[1]);

  // 4. Swim threshold/speed → Wednesday (isolated mid-week quality). Other
  //    swims distribute across Tue, Fri, Mon, Thu.
  const swimsRemaining = [...swim];
  const swimQualityIdx = swimsRemaining.findIndex((w) => w.t === 'swim_threshold' || w.t === 'swim_speed');
  if (swimQualityIdx >= 0) {
    const q = swimsRemaining.splice(swimQualityIdx, 1)[0];
    place(2, q);
  }
  placeByPreference(swimsRemaining, SWIM_DAYS, byDay, occupiedDisciplines, hasCapacity, place);

  // 5. Bike quality → Tuesday (first remaining bike). Others distribute Thu, Fri.
  placeByPreference(bike, BIKE_DAYS, byDay, occupiedDisciplines, hasCapacity, place);

  // 6. Run sessions: quality tends to be first in the list. Tuesday easy,
  //    Thursday quality is the template — we spread by preference.
  placeByPreference(run, RUN_DAYS, byDay, occupiedDisciplines, hasCapacity, place);

  // Flatten with dayOfWeek/dayName set
  const out: Workout[] = [];
  for (let d = 0; d < 7; d++) {
    byDay[d].forEach((w) => {
      out.push({ ...w, dayOfWeek: d, dayName: DAY_NAMES[d] });
    });
  }

  void phase;
  return out;
}

/**
 * Place each workout on its preferred day, skipping days that already host
 * the same discipline or lack capacity. Falls back through:
 *   1. Preferred days with capacity AND no same-discipline collision
 *   2. Weekend days (even if outside the discipline's preferred set) when
 *      weekday capacity is exhausted
 *   3. Preferred day with fewest sessions (last resort — exceeds cap)
 */
function placeByPreference(
  workouts: Workout[],
  preferredDays: number[],
  byDay: Record<number, Workout[]>,
  occupied: Record<number, Set<string>>,
  hasCapacity: (day: number, w: Workout) => boolean,
  place: (day: number, w: Workout) => void
): void {
  for (const w of workouts) {
    const disc = w.discipline ?? 'run';
    // 1. Preferred day with capacity + no same-discipline collision
    let dayIdx = preferredDays.find((d) => !occupied[d].has(disc) && hasCapacity(d, w));
    // 2. Weekend spill (no collision + capacity)
    if (dayIdx === undefined) {
      dayIdx = WEEKEND_INDEXES.find((d) => !occupied[d].has(disc) && hasCapacity(d, w));
    }
    // 3. Weekend with capacity (collisions allowed — two-a-day)
    if (dayIdx === undefined) {
      dayIdx = WEEKEND_INDEXES.find((d) => hasCapacity(d, w));
    }
    // 4. Preferred day with capacity (collisions allowed)
    if (dayIdx === undefined) {
      dayIdx = preferredDays.find((d) => hasCapacity(d, w));
    }
    // 5. Last-resort: pick the day with the least cap pressure. We pick
    //    across weekend FIRST then weekdays, and break ties by fewest
    //    sessions. This ensures a user who set 0h weekday never sees
    //    weekday workouts unless there's literally nowhere else to go.
    if (dayIdx === undefined) {
      const allDays = [...WEEKEND_INDEXES, ...preferredDays];
      dayIdx = allDays.reduce((best, d) =>
        byDay[d].length < byDay[best].length ? d : best,
      allDays[0]);
    }
    place(dayIdx, w);
  }
}

function workoutMinutes(w: Workout): number {
  if (w.estimatedDurationMin && w.estimatedDurationMin > 0) return w.estimatedDurationMin;
  if (w.brickSegments) {
    return (w.brickSegments[0]?.durationMin ?? 0) + (w.brickSegments[1]?.durationMin ?? 0);
  }
  const matches = Array.from(String(w.d || '').matchAll(/(\d+)\s*min/g));
  if (matches.length > 0) {
    return matches.reduce((acc, m) => Math.max(acc, parseInt(m[1], 10)), 0);
  }
  return 60;
}

