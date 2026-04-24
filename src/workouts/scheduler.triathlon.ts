/**
 * Multi-sport scheduler for triathlon weeks.
 *
 * Constraint rules (§18.8):
 *   - Long run → Sunday, long bike or brick → Saturday
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
  gym: Workout[] = []
): Workout[] {
  const byDay: Record<number, Workout[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

  // Track which disciplines are already on each day so we avoid same-
  // discipline doubles unless we really have to.
  const occupiedDisciplines: Record<number, Set<string>> = {
    0: new Set(), 1: new Set(), 2: new Set(), 3: new Set(),
    4: new Set(), 5: new Set(), 6: new Set(),
  };
  const place = (day: number, w: Workout) => {
    byDay[day].push(w);
    occupiedDisciplines[day].add(w.discipline ?? 'run');
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
  placeByPreference(swimsRemaining, SWIM_DAYS, byDay, occupiedDisciplines, place);

  // 5. Bike quality → Tuesday (first remaining bike). Others distribute Thu, Fri.
  placeByPreference(bike, BIKE_DAYS, byDay, occupiedDisciplines, place);

  // 6. Run sessions: quality tends to be first in the list. Tuesday easy,
  //    Thursday quality is the template — we spread by preference.
  placeByPreference(run, RUN_DAYS, byDay, occupiedDisciplines, place);

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
 * the same discipline. Falls back to first non-matching day, then any open
 * day, so we never drop a session.
 */
function placeByPreference(
  workouts: Workout[],
  preferredDays: number[],
  byDay: Record<number, Workout[]>,
  occupied: Record<number, Set<string>>,
  place: (day: number, w: Workout) => void
): void {
  for (const w of workouts) {
    const disc = w.discipline ?? 'run';
    // First pass: pick the first preferred day that doesn't already have this discipline.
    let dayIdx = preferredDays.find((d) => !occupied[d].has(disc));
    // Fallback: pick the preferred day with fewest sessions overall.
    if (dayIdx === undefined) {
      dayIdx = preferredDays.reduce((best, d) =>
        byDay[d].length < byDay[best].length ? d : best,
      preferredDays[0]);
    }
    place(dayIdx, w);
  }
}
