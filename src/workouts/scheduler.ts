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

  // Count total hard sessions (quality + long)
  const totalHard = quality.length + (long ? 1 : 0);

  if (totalHard >= 4) {
    // 4+ hard sessions: space to Mon/Wed/Fri/Sun to avoid consecutive hard days
    const hardDays = [0, 2, 4, 6]; // Mon, Wed, Fri, Sun
    const allHard = [...quality];
    // Long run gets Sunday (last slot)
    if (long) {
      long.dayOfWeek = 6;
      long.dayName = 'Sunday';
    }
    // Assign quality to Mon/Wed/Fri (skip Sunday if long takes it)
    const qualitySlots = long ? hardDays.filter(d => d !== 6) : hardDays;
    quality.forEach((w, i) => {
      if (i < qualitySlots.length) {
        w.dayOfWeek = qualitySlots[i];
        w.dayName = DAY_NAMES[qualitySlots[i]];
      } else {
        // Overflow: find first free odd day (Tue/Thu/Sat)
        const overflow = [1, 3, 5].find(d => !allHard.some(h => h.dayOfWeek === d) && !(long && long.dayOfWeek === d));
        if (overflow !== undefined) {
          w.dayOfWeek = overflow;
          w.dayName = DAY_NAMES[overflow];
        }
      }
    });
  } else {
    // Standard: Long → Sunday, quality → Tue/Thu
    if (long) {
      long.dayOfWeek = 6;
      long.dayName = 'Sunday';
    }

    const qualityDays = [1, 3]; // Tuesday, Thursday
    quality.forEach((w, i) => {
      if (i < qualityDays.length) {
        w.dayOfWeek = qualityDays[i];
        w.dayName = DAY_NAMES[qualityDays[i]];
      } else {
        w.dayOfWeek = 5;
        w.dayName = 'Saturday';
      }
    });
  }

  // Build set of days already taken by hard workouts
  const hardDaySet = new Set<number>();
  workouts.forEach(w => {
    if (w.dayOfWeek !== undefined) hardDaySet.add(w.dayOfWeek);
  });

  // Assign commute runs to weekdays not taken by hard workouts
  const commuteDayOptions = [0, 1, 2, 3, 4].filter(d => !hardDaySet.has(d));
  let commuteIdx = 0;
  commute.forEach(w => {
    if (commuteIdx < commuteDayOptions.length) {
      w.dayOfWeek = commuteDayOptions[commuteIdx];
      w.dayName = DAY_NAMES[commuteDayOptions[commuteIdx]];
    } else {
      // Stack on first available weekday
      const day = commuteDayOptions[commuteIdx % commuteDayOptions.length];
      w.dayOfWeek = day;
      w.dayName = DAY_NAMES[day];
    }
    commuteIdx++;
  });

  // Rebuild taken days including commute
  const allTakenDays = new Set<number>();
  workouts.forEach(w => {
    if (w.dayOfWeek !== undefined) allTakenDays.add(w.dayOfWeek);
  });

  // Find free days for easy runs — prefer spacing them apart
  const totalWorkouts = workouts.length;
  const freeDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !allTakenDays.has(d));

  // If >7 workouts, no free days available — easy runs share days with cross-training/commute
  // Prefer days that only have cross-training (not hard workouts)
  const crossDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !hardDaySet.has(d) && allTakenDays.has(d));
  const easySlots = freeDays.length > 0 ? freeDays : crossDays;

  let easySlotIdx = 0;
  easy.forEach(w => {
    if (easySlotIdx < easySlots.length) {
      w.dayOfWeek = easySlots[easySlotIdx];
      w.dayName = DAY_NAMES[easySlots[easySlotIdx]];
      easySlotIdx++;
    } else if (freeDays.length > 0) {
      // Cycle through free days if more easy runs than free slots
      const day = freeDays[easySlotIdx % freeDays.length];
      w.dayOfWeek = day;
      w.dayName = DAY_NAMES[day];
      easySlotIdx++;
    } else if (crossDays.length > 0) {
      // Stack on cross-training days
      const day = crossDays[easySlotIdx % crossDays.length];
      w.dayOfWeek = day;
      w.dayName = DAY_NAMES[day];
      easySlotIdx++;
    } else {
      // Last resort: find the least busy day
      const dayCounts: Record<number, number> = {};
      workouts.forEach(wk => { if (wk.dayOfWeek !== undefined) dayCounts[wk.dayOfWeek] = (dayCounts[wk.dayOfWeek] || 0) + 1; });
      const leastBusy = [0, 1, 2, 3, 4, 5, 6].sort((a, b) => (dayCounts[a] || 0) - (dayCounts[b] || 0))[0];
      w.dayOfWeek = leastBusy;
      w.dayName = DAY_NAMES[leastBusy];
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
    // Don't wrap Sun→Mon — they're 6 days apart within the same week
    const tomorrow = day < 6 ? (byDay[day + 1] || []) : [];

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
