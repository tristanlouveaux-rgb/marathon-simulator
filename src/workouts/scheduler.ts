import type { Workout } from '@/types';
import { DAY_NAMES } from '@/utils';

/**
 * Hard workout types for scheduling conflict detection
 */
const HARD_WORKOUT_TYPES = [
  'threshold', 'vo2', 'race_pace', 'marathon_pace',
  'intervals', 'long', 'mixed', 'progressive'
];

/** Non-run activity types that should be scheduled after runs */
const CROSS_TYPES = ['cross', 'strength', 'rest', 'test_run', 'gym'];

/**
 * Check if a workout is considered hard
 * @param workoutType - Type of workout
 * @returns True if hard workout
 */
export function isHardWorkout(workoutType: string): boolean {
  return HARD_WORKOUT_TYPES.includes(workoutType);
}

/**
 * Assign default days to workouts using smart scheduling.
 *
 * Priority order:
 *   1. Hard workouts (long + quality) get dedicated days
 *   2. Commute runs fill free weekdays
 *   3. Easy runs fill remaining free days
 *   4. Cross-training goes on whatever is left
 *
 * When total workouts <= 7 a deconfliction pass ensures
 * no day has more than one workout.
 *
 * @param workouts - Array of workouts to schedule
 * @returns Workouts with dayOfWeek assigned
 */
export function assignDefaultDays(workouts: Workout[]): Workout[] {
  // ---- Categorise workouts ----
  const long = workouts.find(w => w.t === 'long');
  const quality = workouts.filter(w =>
    ['threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'mixed', 'progressive'].includes(w.t)
  );
  const commute = workouts.filter(w => w.commute === true);
  const crossTraining = workouts.filter(w => CROSS_TYPES.includes(w.t) && !w.commute);
  const easy = workouts.filter(w =>
    !w.commute &&
    !CROSS_TYPES.includes(w.t) &&
    (w.t === 'easy' ||
    !['long', 'threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'mixed', 'progressive'].includes(w.t))
  );

  // Clear pre-assigned days on cross-training (generator may pre-set these,
  // but we want to place them after runs to avoid conflicts)
  for (const w of crossTraining) {
    w.dayOfWeek = undefined;
    w.dayName = undefined;
  }

  // ---- 1. Assign hard workouts ----
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

  // ---- 2. Assign commute runs to free weekdays ----
  const hardDaySet = new Set<number>();
  workouts.forEach(w => {
    if (w.dayOfWeek !== undefined) hardDaySet.add(w.dayOfWeek);
  });

  const commuteDayOptions = [0, 1, 2, 3, 4].filter(d => !hardDaySet.has(d));
  let commuteIdx = 0;
  commute.forEach(w => {
    if (commuteIdx < commuteDayOptions.length) {
      w.dayOfWeek = commuteDayOptions[commuteIdx];
      w.dayName = DAY_NAMES[commuteDayOptions[commuteIdx]];
    } else if (commuteDayOptions.length > 0) {
      // Stack on first available weekday (only when all weekdays taken)
      const day = commuteDayOptions[commuteIdx % commuteDayOptions.length];
      w.dayOfWeek = day;
      w.dayName = DAY_NAMES[day];
    }
    commuteIdx++;
  });

  // ---- 3. Assign easy runs to remaining free days ----
  const runDays = new Set<number>();
  workouts.forEach(w => {
    if (w.dayOfWeek !== undefined) runDays.add(w.dayOfWeek);
  });

  const freeDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !runDays.has(d));

  let easySlotIdx = 0;
  easy.forEach(w => {
    if (easySlotIdx < freeDays.length) {
      w.dayOfWeek = freeDays[easySlotIdx];
      w.dayName = DAY_NAMES[freeDays[easySlotIdx]];
      easySlotIdx++;
    } else if (freeDays.length > 0) {
      // Cycle through free days if more easy runs than free slots
      const day = freeDays[easySlotIdx % freeDays.length];
      w.dayOfWeek = day;
      w.dayName = DAY_NAMES[day];
      easySlotIdx++;
    } else {
      // No free days: find least busy non-hard day
      const dayCounts: Record<number, number> = {};
      workouts.forEach(wk => { if (wk.dayOfWeek !== undefined) dayCounts[wk.dayOfWeek] = (dayCounts[wk.dayOfWeek] || 0) + 1; });
      const nonHard = [0, 1, 2, 3, 4, 5, 6].filter(d => !hardDaySet.has(d));
      const candidates = nonHard.length > 0 ? nonHard : [0, 1, 2, 3, 4, 5, 6];
      const leastBusy = [...candidates].sort((a, b) => (dayCounts[a] || 0) - (dayCounts[b] || 0))[0];
      w.dayOfWeek = leastBusy;
      w.dayName = DAY_NAMES[leastBusy];
    }
  });

  // ---- 4. Assign cross-training to remaining free days ----
  const allDaysAfterRuns = new Set<number>();
  workouts.forEach(w => {
    if (w.dayOfWeek !== undefined) allDaysAfterRuns.add(w.dayOfWeek);
  });
  const crossFreeDays = [0, 1, 2, 3, 4, 5, 6].filter(d => !allDaysAfterRuns.has(d));
  // Prefer non-hard days for cross-training
  const nonHardFree = crossFreeDays.filter(d => !hardDaySet.has(d));
  const crossSlots = nonHardFree.length > 0
    ? [...nonHardFree, ...crossFreeDays.filter(d => hardDaySet.has(d))]
    : crossFreeDays;

  let crossIdx = 0;
  crossTraining.forEach(w => {
    if (crossIdx < crossSlots.length) {
      w.dayOfWeek = crossSlots[crossIdx];
      w.dayName = DAY_NAMES[crossSlots[crossIdx]];
    } else {
      // More cross-training than free days: stack on least busy non-hard day
      const dayCounts: Record<number, number> = {};
      workouts.forEach(wk => { if (wk.dayOfWeek !== undefined) dayCounts[wk.dayOfWeek] = (dayCounts[wk.dayOfWeek] || 0) + 1; });
      const nonHard = [0, 1, 2, 3, 4, 5, 6].filter(d => !hardDaySet.has(d));
      const candidates = nonHard.length > 0 ? nonHard : [0, 1, 2, 3, 4, 5, 6];
      const leastBusy = [...candidates].sort((a, b) => (dayCounts[a] || 0) - (dayCounts[b] || 0))[0];
      w.dayOfWeek = leastBusy;
      w.dayName = DAY_NAMES[leastBusy];
    }
    crossIdx++;
  });

  // ---- 5. Deconfliction: if <= 7 workouts, no day should have more than 1 ----
  if (workouts.length <= 7) {
    spreadToAvoidStacking(workouts);
  }

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
 * When <= 7 workouts, move stacked workouts to free days.
 * Moves the most movable workout (cross > easy > commute > hard).
 */
function spreadToAvoidStacking(workouts: Workout[]): void {
  for (let iter = 0; iter < workouts.length; iter++) {
    // Group by day
    const byDay = new Map<number, Workout[]>();
    for (const w of workouts) {
      if (w.dayOfWeek === undefined) continue;
      if (!byDay.has(w.dayOfWeek)) byDay.set(w.dayOfWeek, []);
      byDay.get(w.dayOfWeek)!.push(w);
    }

    // Find free days
    const usedDays = new Set(byDay.keys());
    const free = [0, 1, 2, 3, 4, 5, 6].filter(d => !usedDays.has(d));
    if (free.length === 0) break;

    // Find a stacked day and move the most movable workout
    let moved = false;
    for (const [, dayWorkouts] of byDay) {
      if (dayWorkouts.length <= 1) continue;

      // Pick the most movable workout (highest priority number)
      const sorted = [...dayWorkouts].sort((a, b) => movePriority(b) - movePriority(a));
      const toMove = sorted[0];

      toMove.dayOfWeek = free[0];
      toMove.dayName = DAY_NAMES[free[0]];
      moved = true;
      break; // Recompute after each move
    }

    if (!moved) break;
  }
}

/** Higher number = more willing to move */
function movePriority(w: Workout): number {
  if (CROSS_TYPES.includes(w.t) && w.t !== 'gym') return 4;
  if (w.t === 'gym') return 3.5;  // Gym stays put more than cross, less than easy
  if (w.t === 'easy') return 3;
  if (w.commute) return 2;
  return 1; // hard workouts stay put
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
