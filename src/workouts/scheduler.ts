import type { Workout } from '@/types';
import { DAY_NAMES } from '@/utils';

/**
 * Hard workout types for scheduling conflict detection
 */
const HARD_WORKOUT_TYPES = [
  'threshold', 'vo2', 'race_pace', 'marathon_pace',
  'intervals', 'long', 'mixed', 'progressive'
];

/**
 * Check if a workout is considered hard
 * @param workoutType - Type of workout
 * @returns True if hard workout
 */
export function isHardWorkout(workoutType: string): boolean {
  return HARD_WORKOUT_TYPES.includes(workoutType);
}

/**
 * Assign default days to workouts using smart scheduling
 * Long Run → Sunday (6)
 * First Quality (Threshold/VO2) → Tuesday (1)
 * Second Quality (Race Pace/Tempo) → Thursday (3)
 * Easy runs → Fill Mon(0), Wed(2), Fri(4), Sat(5)
 *
 * @param workouts - Array of workouts to schedule
 * @returns Workouts with dayOfWeek assigned
 */
export function assignDefaultDays(workouts: Workout[]): Workout[] {
  // Identify workout types
  const long = workouts.find(w => w.t === 'long');
  const quality = workouts.filter(w =>
    ['threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'mixed', 'progressive'].includes(w.t)
  );
  const commute = workouts.filter(w => w.commute === true);
  const easy = workouts.filter(w =>
    !w.commute &&
    (w.t === 'easy' ||
    !['long', 'threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'mixed', 'progressive'].includes(w.t))
  );

  // Assign long run to Sunday
  if (long) {
    long.dayOfWeek = 6;
    long.dayName = 'Sunday';
  }

  // Default quality days
  const qualityDays = [1, 3]; // Tuesday, Thursday

  // Assign quality workouts
  quality.forEach((w, i) => {
    if (i < qualityDays.length) {
      w.dayOfWeek = qualityDays[i];
      w.dayName = DAY_NAMES[qualityDays[i]];
    } else {
      // Extra quality sessions go to Saturday
      w.dayOfWeek = 5;
      w.dayName = 'Saturday';
    }
  });

  // Track which days are taken
  const takenDays = new Set<number>();
  workouts.forEach(w => {
    if (w.dayOfWeek !== undefined) takenDays.add(w.dayOfWeek);
  });

  // Assign commute runs to weekdays (Mon-Fri), spread evenly
  const commuteDayOptions = [0, 1, 2, 3, 4]; // Mon-Fri
  let commuteIdx = 0;
  commute.forEach(w => {
    // Find next weekday, cycling through Mon-Fri
    const day = commuteDayOptions[commuteIdx % commuteDayOptions.length];
    w.dayOfWeek = day;
    w.dayName = DAY_NAMES[day];
    commuteIdx++;
  });

  // Assign easy runs to remaining days (Mon, Wed, Fri, Sat)
  const easyDays = [0, 2, 4, 5]; // Mon, Wed, Fri, Sat
  let easyDayIndex = 0;

  easy.forEach(w => {
    // Skip days already taken by quality workouts
    while (easyDayIndex < easyDays.length) {
      const day = easyDays[easyDayIndex];
      const dayTaken = quality.some(q => q.dayOfWeek === day);
      if (!dayTaken) {
        w.dayOfWeek = day;
        w.dayName = DAY_NAMES[day];
        easyDayIndex++;
        break;
      }
      easyDayIndex++;
    }
    // If we run out of days, stack on Saturday
    if (w.dayOfWeek === undefined) {
      w.dayOfWeek = 5;
      w.dayName = 'Saturday';
    }
  });

  // Ensure all workouts have a day assigned
  workouts.forEach(w => {
    if (w.dayOfWeek === undefined) {
      w.dayOfWeek = 0;
      w.dayName = 'Monday';
    }
  });

  return workouts;
}

/**
 * Check for consecutive hard days and return warnings
 * @param workouts - Array of workouts
 * @returns Array of warning objects
 */
export function checkConsecutiveHardDays(workouts: Workout[]): { level: string; message: string }[] {
  const warnings: { level: string; message: string }[] = [];

  // Group workouts by day
  const byDay: Record<number, Workout[]> = {};
  workouts.forEach(w => {
    if (w.dayOfWeek === undefined) return;
    if (!byDay[w.dayOfWeek]) byDay[w.dayOfWeek] = [];
    byDay[w.dayOfWeek].push(w);
  });

  // Check each day
  for (let day = 0; day <= 6; day++) {
    const today = byDay[day] || [];
    const tomorrow = byDay[(day + 1) % 7] || [];

    const hardToday = today.some(w => isHardWorkout(w.t));
    const hardTomorrow = tomorrow.some(w => isHardWorkout(w.t));

    if (hardToday && hardTomorrow) {
      const todayNames = today.filter(w => isHardWorkout(w.t)).map(w => w.n).join(', ');
      const tomorrowNames = tomorrow.filter(w => isHardWorkout(w.t)).map(w => w.n).join(', ');
      warnings.push({
        level: 'critical',
        message: `Hard workouts on consecutive days: ${todayNames} (${today[0].dayName}) → ${tomorrowNames} (${tomorrow[0].dayName})`
      });
    }

    // Check for multiple hard workouts same day
    const hardCount = today.filter(w => isHardWorkout(w.t)).length;
    if (hardCount > 1) {
      const names = today.filter(w => isHardWorkout(w.t)).map(w => w.n).join(', ');
      warnings.push({
        level: 'critical',
        message: `Multiple hard workouts on ${today[0].dayName}: ${names}`
      });
    }
  }

  return warnings;
}

/**
 * Move a workout to a different day
 * @param workout - Workout to move
 * @param newDay - New day index (0-6)
 */
export function moveWorkoutToDay(workout: Workout, newDay: number): void {
  workout.dayOfWeek = newDay;
  workout.dayName = DAY_NAMES[newDay];
}
