import type { WorkoutLoad } from '@/types';
import { LOAD_PROFILES, LOAD_PER_MIN_BY_INTENSITY } from '@/constants';

/**
 * Calculate expected aerobic and anaerobic load for a workout
 * @param workoutType - Type of workout
 * @param durationDesc - Duration description (number or string)
 * @param intensityPct - Intensity percentage (0-100)
 * @returns Workout load breakdown
 */
export function calculateWorkoutLoad(
  workoutType: string,
  durationDesc: number | string,
  intensityPct: number,
  easyPaceSecPerKm?: number
): WorkoutLoad {
  const profile = LOAD_PROFILES[workoutType] || { aerobic: 0.80, anaerobic: 0.20 };

  // Handle replaced/skipped workouts explicitly
  if (typeof durationDesc === 'string' && durationDesc.toLowerCase().includes('replaced')) {
    return { aerobic: 0, anaerobic: 0, total: 0 };
  }

  // Derive pace estimates from the runner's actual easy pace (if available)
  const baseMinPerKm = easyPaceSecPerKm ? easyPaceSecPerKm / 60 : 5.5;

  // Parse duration from various formats
  let dur = 0;

  if (typeof durationDesc === 'number') {
    dur = durationDesc;
  } else if (typeof durationDesc === 'string') {
    // Try to extract km
    const kmMatch = durationDesc.match(/(\d+)km/);
    if (kmMatch) {
      const km = parseInt(kmMatch[1]);
      // Estimate pace based on workout type, scaled from runner's easy pace
      let paceMinPerKm = baseMinPerKm;
      if (workoutType === 'easy') paceMinPerKm = baseMinPerKm;
      else if (workoutType === 'long') paceMinPerKm = baseMinPerKm * 1.03;
      else if (workoutType === 'threshold') paceMinPerKm = baseMinPerKm * 0.82;
      else if (workoutType === 'vo2') paceMinPerKm = baseMinPerKm * 0.73;
      else if (workoutType === 'race_pace') paceMinPerKm = baseMinPerKm * 0.78;
      else if (workoutType === 'marathon_pace') paceMinPerKm = baseMinPerKm * 0.87;

      dur = km * paceMinPerKm;
    } else {
      // Try to extract minutes (e.g., "3×10min")
      const minMatch = durationDesc.match(/(\d+)×(\d+)min/);
      if (minMatch) {
        const reps = parseInt(minMatch[1]);
        const repDur = parseInt(minMatch[2]);
        dur = reps * repDur;
      } else {
        // Try simple "45min"
        const simpleMatch = durationDesc.match(/(\d+)min/);
        if (simpleMatch) {
          dur = parseInt(simpleMatch[1]);
        } else {
          // Default by workout type
          if (workoutType === 'long') dur = 120;
          else if (workoutType === 'threshold' || workoutType === 'vo2') dur = 45;
          else dur = 40;
        }
      }
    }
  }

  if (!dur || dur <= 0) dur = 40; // Fallback

  // Calculate load to match GARMIN scale
  const estimatedRPE = (intensityPct || 50) / 10; // Convert back to 1-10 scale
  const baseRate = LOAD_PER_MIN_BY_INTENSITY[Math.round(estimatedRPE)] || 2.0;
  const totalLoad = dur * baseRate;

  // Split into aerobic/anaerobic based on workout type
  const aerobicLoad = totalLoad * profile.aerobic;
  const anaerobicLoad = totalLoad * profile.anaerobic;

  return {
    aerobic: Math.round(aerobicLoad),
    anaerobic: Math.round(anaerobicLoad),
    total: Math.round(aerobicLoad + anaerobicLoad * 1.15)
  };
}
