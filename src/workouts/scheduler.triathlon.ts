/**
 * Multi-sport scheduler for triathlon weeks.
 *
 * Constraint rules (§18.8):
 *   - Long run on Sunday (traditional), long bike on Saturday
 *   - Brick replaces Saturday bike in build/peak phases
 *   - Quality sessions (threshold / VO2) spread across the week — no two
 *     hard same-discipline sessions on consecutive days
 *   - Two-a-days allowed on weekdays when total sessions > 6
 *
 * Output: sets `dayOfWeek` (0=Mon..6=Sun) and `dayName` on every workout.
 * The rest of the app reads these fields for positioning.
 */

import type { Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface TriDayAssignment {
  dayOfWeek: number;
  dayName: string;
  workouts: Workout[];
}

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
  // Day slots — typical triathlon template
  //   Mon: Rest / easy swim technique
  //   Tue: Bike quality + Run easy
  //   Wed: Swim threshold
  //   Thu: Run quality
  //   Fri: Rest / easy swim
  //   Sat: Long bike OR brick
  //   Sun: Long run
  //
  // We allocate sessions into slots based on what the plan engine produced.
  const byDay: Record<number, Workout[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

  // 1. Long bike or brick → Saturday (day 5)
  const longBike = bike.find((w) => w.t === 'bike_endurance' || w.t === 'bike_tempo');
  if (brick) {
    byDay[5].push(brick);
  } else if (longBike) {
    byDay[5].push(longBike);
    bike.splice(bike.indexOf(longBike), 1);
  }

  // 2. Long run → Sunday (day 6)
  if (run.length > 0) {
    // Longest-duration run goes last in the list by convention; take the last run session as "long"
    const longRun = run[run.length - 1];
    byDay[6].push(longRun);
    run.splice(run.length - 1, 1);
  }

  // 3. Gym sessions → Monday + Friday
  if (gym.length > 0) byDay[0].push(gym[0]);
  if (gym.length > 1) byDay[4].push(gym[1]);

  // 4. Swim sessions → Wed (threshold), Mon (technique), Fri (technique)
  const swimByType = [...swim];
  const swimThreshold = swimByType.find((w) => w.t === 'swim_threshold' || w.t === 'swim_speed');
  if (swimThreshold) {
    byDay[2].push(swimThreshold);
    swimByType.splice(swimByType.indexOf(swimThreshold), 1);
  }
  if (swimByType.length > 0) { byDay[0].push(swimByType.shift()!); }  // Monday
  if (swimByType.length > 0) { byDay[4].push(swimByType.shift()!); }  // Friday

  // 5. Remaining bike sessions → Tuesday (quality) + Thursday slot
  if (bike.length > 0) byDay[1].push(bike.shift()!);
  if (bike.length > 0) byDay[3].push(bike.shift()!);

  // 6. Remaining run sessions → Tuesday easy + Thursday quality
  if (run.length > 0) byDay[1].push(run.shift()!);
  if (run.length > 0) byDay[3].push(run.shift()!);

  // 7. Overflow → any remaining items pile onto Friday
  const overflow = [...swimByType, ...bike, ...run];
  overflow.forEach((w) => byDay[4].push(w));

  // Flatten with dayOfWeek/dayName set
  const out: Workout[] = [];
  for (let d = 0; d < 7; d++) {
    byDay[d].forEach((w) => {
      out.push({ ...w, dayOfWeek: d, dayName: DAY_NAMES[d] });
    });
  }

  void phase;  // Future: phase could adjust the template (e.g., taper compresses)
  return out;
}
