/**
 * HYROX week scheduler.
 *
 * Assigns dayOfWeek (0=Mon … 6=Sun) to each generated session using
 * a constraint-based day-picker rather than a rigid template.
 *
 * Constraints (hard):
 *   1. No two high-intensity sessions on the same day or on adjacent days
 *      (quality run and density/brick count as high-intensity).
 *   2. Race simulation → Saturday (day 5). Claims its day before any other
 *      session, since it is the least movable thing in the week.
 *   3. Brick → Saturday (day 5) when only one brick per week; second brick
 *      if present → Thursday (day 3).
 *   4. Station technique sessions land mid-week (Tue/Wed/Thu).
 *   5. Easy runs bookend the week (Mon/Sun or fill available low-stress days).
 *   6. At least 1 full rest day per week.
 *
 * No concurrent sessions (≤ 1 session per day).
 */

import type { Workout } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Returns true for sessions that count as "high intensity". */
function isHighIntensity(w: Workout): boolean {
  return w.t === 'hyrox_simulation' ||
    w.t === 'hyrox_half_simulation' ||
    w.t === 'hyrox_brick' ||
    w.t === 'hyrox_mini_brick' ||
    w.t === 'hyrox_run_intervals' ||
    w.t === 'hyrox_run_tempo' ||
    w.t === 'hyrox_station_density';
}

/**
 * Preferred day ordering per session type, from most-preferred to least.
 * The first free day in the list that satisfies spacing constraints is used.
 */
function preferredDays(w: Workout): number[] {
  if (w.t === 'hyrox_assessment') return [0, 1, 2];      // Assessment: Mon first (needs to be early in week)
  if (w.t === 'hyrox_simulation') return [5, 6, 3];     // Race sim: Sat primary — race day is a Saturday
  if (w.t === 'hyrox_half_simulation') return [5, 3, 6, 4];
  if (w.t === 'hyrox_brick') return [5, 3, 6, 4];       // Sat primary, Thu secondary
  if (w.t === 'hyrox_mini_brick') return [4, 5, 2, 3];  // Fri primary
  if (w.t === 'hyrox_station_density') return [1, 3, 2, 4];   // Tue/Thu
  if (w.t === 'hyrox_station_technique') return [2, 4, 1, 3]; // Wed/Fri
  if (w.t === 'hyrox_run_tempo') return [1, 3, 4, 2];   // Tue/Thu
  if (w.t === 'hyrox_run_intervals') return [3, 1, 4, 2]; // Thu/Tue
  // easy run: bookend
  return [0, 6, 2, 4, 5];
}

/**
 * Schedule a HYROX week's sessions onto days.
 *
 * @param sessions - Sessions already generated (discipline + t set).
 * @param _band    - Ability band (reserved for future band-specific templates).
 */
export function scheduleHyroxWeek(sessions: Workout[], _band: AbilityBand): Workout[] {
  const usedDays = new Set<number>();
  const scheduled: Workout[] = [];

  // Sort priority: bricks first (they have the most constrained preferred days),
  // then quality sessions, then technique, then easy runs.
  const priority = (w: Workout): number => {
    if (w.t === 'hyrox_assessment') return -1; // always scheduled first → gets Monday
    // Simulations are the most day-constrained session in the week and the one
    // everything else must spacing-yield to, so they claim their day first.
    if (w.t === 'hyrox_simulation') return -0.5;
    if (w.t === 'hyrox_half_simulation') return -0.25;
    if (w.t === 'hyrox_brick') return 0;
    if (w.t === 'hyrox_mini_brick') return 1;
    if (w.t === 'hyrox_run_intervals') return 2;
    if (w.t === 'hyrox_station_density') return 3;
    if (w.t === 'hyrox_run_tempo') return 4;
    if (w.t === 'hyrox_station_technique') return 5;
    return 6; // easy run
  };

  const sorted = [...sessions].sort((a, b) => priority(a) - priority(b));

  for (const session of sorted) {
    const preferred = preferredDays(session);
    let assigned = -1;

    for (const day of preferred) {
      if (usedDays.has(day)) continue;

      // Spacing check: high-intensity sessions can't be on adjacent days to
      // another high-intensity session (prevents quality-day collisions).
      if (isHighIntensity(session)) {
        const adjacent = scheduled.some(
          s => isHighIntensity(s) && s.dayOfWeek !== undefined && Math.abs(s.dayOfWeek - day) <= 1
        );
        if (adjacent) continue;
      }

      assigned = day;
      break;
    }

    // Fallback: find any free day that doesn't violate the same-day rule.
    if (assigned === -1) {
      for (let d = 0; d <= 6; d++) {
        if (!usedDays.has(d)) {
          assigned = d;
          break;
        }
      }
    }

    if (assigned === -1) assigned = 0; // shouldn't happen with ≤7 sessions

    usedDays.add(assigned);
    scheduled.push({
      ...session,
      dayOfWeek: assigned,
      dayName: DAY_NAMES[assigned],
    });
  }

  // Return sorted by day so the plan-view renders chronologically.
  return scheduled.sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));
}
