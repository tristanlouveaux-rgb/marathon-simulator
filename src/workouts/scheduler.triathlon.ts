/**
 * Multi-sport scheduler for triathlon weeks.
 *
 * Constraint rules (§18.8):
 *   - Long run → Sunday, long bike or brick → Saturday
 *   - Respect weekday hour cap: Mon–Fri combined must fit the user's
 *     available weekday hours (e.g. 9-to-5 users can only spare ~1h/day)
 *   - Quality sessions (threshold / VO2) spread across the week. No two
 *     hard same-discipline sessions on consecutive days
 *   - Swim threshold mid-week (Wed) to separate from bike/run quality
 *   - Never double up the SAME discipline on the same day unless it's an
 *     explicit two-a-day (e.g. PM swim after AM run in peak phases)
 *   - Race week: never the same discipline twice on one day; a session
 *     with no free day for its discipline is left out.
 *   - No second run on the day of the long run or the brick (whose
 *     transition run is a run). The capacity fallbacks used to stack a run
 *     there when weekday capacity ran out (a 70.3 build week: an 80-min long
 *     run and a 50-min easy run on Sunday).
 *   - A run (not a commute) that fits no day within its cap takes the day
 *     without a run that it overshoots least, as a cross-discipline
 *     two-a-day, before it may share a weekday with another run
 *     (placeByPreference step 3b). The weekend two-a-day of step 3 stays: a
 *     user whose weekday hours are spent can still hold two runs on Saturday.
 *
 * Output: sets `dayOfWeek` (0=Mon..6=Sun) and `dayName` on every workout.
 */

import type { Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import { isLongRun } from './long-run';

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Preferred day order per discipline (0=Mon..6=Sun).
// Picks spread across the week with a rest-friendly Monday.
const SWIM_DAYS = [1, 2, 4, 0, 3];        // Tue, Wed, Fri, Mon, Thu
const BIKE_DAYS = [1, 3, 4];              // Tue, Thu, Fri (Saturday reserved for long bike / brick)
const RUN_DAYS  = [2, 3, 1, 4, 0];        // Wed, Thu, Tue, Fri, Mon (Sunday reserved for long run)

/** The day the first remaining ride, the week's bike quality session, takes
 *  (step 5 below). The race-week primer's home day (race-day-rules
 *  raceWeekPrimerDow). */
export const TRI_BIKE_QUALITY_DOW = BIKE_DAYS[0];

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
  minutesCapByDay?: Record<number, number>,
  /** Race week (plan_engine isRaceWeek). The week has no long run, and:
   *   - Sunday, the long-run slot the race takes (SCIENCE_LOG §CT), is kept
   *     free, whatever the race weekday. A Monday to Wednesday race's primer
   *     may still move there afterwards (race-day-rules
   *     placeStoredPlanRaceWeekPrimer);
   *   - no discipline twice on one day: a session with no day free of its
   *     discipline is left out of the week. Two rides on one day give the
   *     stimulus of one with more fatigue, so they keep no frequency (the
   *     reason race week keeps the week before's count, triRaceWeekCounts). */
  raceWeek: boolean = false,
): Workout[] {
  const weekendDays = raceWeek ? [5] : WEEKEND_INDEXES;
  const byDay: Record<number, Workout[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const minutesOnDay: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

  // Track which disciplines are already on each day so we avoid same-
  // discipline doubles unless we really have to.
  const occupiedDisciplines: Record<number, Set<string>> = {
    0: new Set(), 1: new Set(), 2: new Set(), 3: new Set(),
    4: new Set(), 5: new Set(), 6: new Set(),
  };
  // Days holding the long run or the brick: no other run is placed there.
  const runAnchoredDays = new Set<number>();
  const place = (day: number, w: Workout) => {
    byDay[day].push(w);
    minutesOnDay[day] += workoutMinutes(w);
    occupiedDisciplines[day].add(w.discipline ?? 'run');
    if (w.t === 'brick' || isLongRun(w)) runAnchoredDays.add(day);
  };
  const allowed = (day: number, w: Workout): boolean =>
    (w.discipline ?? 'run') !== 'run' || !runAnchoredDays.has(day);

  const hasCapacity = (day: number, w: Workout): boolean => {
    if (!minutesCapByDay) return true;
    const cap = minutesCapByDay[day];
    if (cap === undefined) return true;
    return minutesOnDay[day] + workoutMinutes(w) <= cap + 15;  // 15 min tolerance
  };
  /** Minutes by which `w` would overshoot the day's cap (no cap: none). */
  const overCap = (day: number, w: Workout): number => {
    const cap = minutesCapByDay?.[day];
    return cap === undefined ? 0 : minutesOnDay[day] + workoutMinutes(w) - cap;
  };

  // 1. Long session Saturday. On brick weeks the brick IS the long ride (the long
  //    ride was popped into the brick in the engine, SCIENCE_LOG §CD), so placing
  //    the brick here places the long-bike day. Off brick weeks, the long ride is
  //    still a solo session and goes here.
  if (brick) {
    place(5, brick);
  } else {
    // Longest bike (last in array by convention) → Saturday
    if (bike.length > 0) {
      const longBike = bike.pop()!;
      place(5, longBike);
    }
  }

  // 2. Long run → Sunday. Found by type, not array position: commute runs are
  //    appended after the generated runs, so "last in the array" put a commute on
  //    Sunday and the long run on a weekday, and a race week (no long run) would
  //    have reserved race day for whatever run came last.
  const longRunIdx = run.findIndex((w) => isLongRun(w) && !w.commute);
  if (longRunIdx >= 0) {
    const [longRun] = run.splice(longRunIdx, 1);
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
  placeByPreference(swimsRemaining, SWIM_DAYS, byDay, occupiedDisciplines, hasCapacity, place, weekendDays, allowed, raceWeek, overCap);

  // 5. Bike quality → Tuesday (first remaining bike). Others distribute Thu, Fri.
  placeByPreference(bike, BIKE_DAYS, byDay, occupiedDisciplines, hasCapacity, place, weekendDays, allowed, raceWeek, overCap);

  // 6. Run sessions: quality tends to be first in the list. Tuesday easy,
  //    Thursday quality is the template. We spread by preference.
  placeByPreference(run, RUN_DAYS, byDay, occupiedDisciplines, hasCapacity, place, weekendDays, allowed, raceWeek, overCap);

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
 *   1. Preferred day with capacity and no same-discipline collision
 *   2. Weekend day with capacity and no collision (weekday capacity spent)
 *   3. Weekend day with capacity, collision allowed (the weekend two-a-day of
 *      a user whose weekday hours are spent)
 *   3b. Runs (not commutes): the day without a run that the run overshoots
 *      least, cap exceeded
 *   4. Preferred day with capacity, collision allowed
 *   5. The day with fewest sessions, weekend first (cap exceeded)
 */
function placeByPreference(
  workouts: Workout[],
  preferredDays: number[],
  byDay: Record<number, Workout[]>,
  occupied: Record<number, Set<string>>,
  hasCapacity: (day: number, w: Workout) => boolean,
  place: (day: number, w: Workout) => void,
  weekendDays: number[] = WEEKEND_INDEXES,
  /** Days this workout may take at all (every step). Runs never take the
   *  long-run or brick day. */
  allowed: (day: number, w: Workout) => boolean = () => true,
  /** Race week: never a day already holding this discipline (steps 3 and 4
   *  skipped, step 5 limited to such days); with none, the session is left
   *  out of the week. */
  noDoubles: boolean = false,
  /** Minutes by which a workout would overshoot a day's cap (step 3b). */
  overCap: (day: number, w: Workout) => number = () => 0,
): void {
  for (const w of workouts) {
    const disc = w.discipline ?? 'run';
    const ok = (d: number) => allowed(d, w) && (!noDoubles || !occupied[d].has(disc));
    // 1. Preferred day with capacity + no same-discipline collision
    let dayIdx = preferredDays.find((d) => ok(d) && !occupied[d].has(disc) && hasCapacity(d, w));
    // 2. Weekend spill (no collision + capacity)
    if (dayIdx === undefined) {
      dayIdx = weekendDays.find((d) => ok(d) && !occupied[d].has(disc) && hasCapacity(d, w));
    }
    // 3. Weekend with capacity (collisions allowed. Two-a-day)
    if (dayIdx === undefined) {
      dayIdx = weekendDays.find((d) => ok(d) && hasCapacity(d, w));
    }
    // 3b. A run that fits no day within its cap takes the day without a run
    //     that it overshoots least, before step 4 can seat it beside another
    //     run on a weekday. Without this step, once the long-run and brick
    //     days were closed to runs, step 4 put an easy run beside a weekday
    //     threshold or VO2 run (Ironman 10 h peak week: Monday held both,
    //     Tuesday's swim plus the run was 1 min over its cap). Commutes keep
    //     steps 4 and 5: a commute is transport on a day the user travels,
    //     and whether it counts as a second run is an open question. Race
    //     week (noDoubles) already limits step 5 to days without a run.
    if (dayIdx === undefined && disc === 'run' && !w.commute && !noDoubles) {
      const runFree = [...preferredDays, ...weekendDays].filter((d) => ok(d) && !occupied[d].has(disc));
      if (runFree.length > 0) {
        dayIdx = runFree.reduce((best, d) => (overCap(d, w) < overCap(best, w) ? d : best), runFree[0]);
      }
    }
    // 4. Preferred day with capacity (collisions allowed)
    if (dayIdx === undefined) {
      dayIdx = preferredDays.find((d) => ok(d) && hasCapacity(d, w));
    }
    // 5. Last-resort: pick the day with the least cap pressure. We pick
    //    across weekend FIRST then weekdays, and break ties by fewest
    //    sessions. This ensures a user who set 0h weekday never sees
    //    weekday workouts unless there's literally nowhere else to go.
    if (dayIdx === undefined) {
      const open = [...weekendDays, ...preferredDays].filter(ok);
      if (open.length === 0 && noDoubles) continue; // race week: no day free of this discipline
      const allDays = open.length > 0 ? open : [...weekendDays, ...preferredDays];
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

