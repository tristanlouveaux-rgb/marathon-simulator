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
    // Handle multi-line descriptions with warm up / cool down
    const lines = durationDesc.split('\n').filter(l => l.trim());
    let mainDesc = durationDesc;
    let wucdMin = 0;
    if (lines.length >= 3 && lines[0].includes('warm up')) {
      mainDesc = lines[1]; // Main set is the middle line
      // Add WU/CD time from "Xkm warm up" and "Xkm cool down"
      const wuMatch = lines[0].match(/^(\d+\.?\d*)km/);
      const cdMatch = lines[lines.length - 1].match(/^(\d+\.?\d*)km/);
      const wuKm = wuMatch ? parseFloat(wuMatch[1]) : 0;
      const cdKm = cdMatch ? parseFloat(cdMatch[1]) : 0;
      wucdMin = (wuKm + cdKm) * baseMinPerKm; // WU/CD at easy pace
    }

    // Try to extract intervals with time (e.g., "5×3min @ 3:47/km ...")
    const intervalTimeMatch = mainDesc.match(/(\d+)×(\d+\.?\d*)min/);
    if (intervalTimeMatch) {
      const reps = parseInt(intervalTimeMatch[1]);
      const repDur = parseFloat(intervalTimeMatch[2]);
      // Also extract recovery if present
      const recMatch = mainDesc.match(/(\d+\.?\d*)\s*min\s*recovery/);
      const recMin = recMatch ? parseFloat(recMatch[1]) : 0;
      dur = reps * repDur + (reps - 1) * recMin + wucdMin;
    }
    // Try simple "Xmin @ pace"
    else if (mainDesc.match(/(\d+)min\s*@/)) {
      const simpleTimeMatch = mainDesc.match(/(\d+)min/);
      dur = simpleTimeMatch ? parseInt(simpleTimeMatch[1]) + wucdMin : wucdMin;
    }
    // Try to extract km (simple distance workouts)
    else {
      const kmMatch = mainDesc.match(/(\d+\.?\d*)km/);
      if (kmMatch) {
        const km = parseFloat(kmMatch[1]);
        let paceMinPerKm = baseMinPerKm;
        if (workoutType === 'easy') paceMinPerKm = baseMinPerKm;
        else if (workoutType === 'long') paceMinPerKm = baseMinPerKm * 1.03;
        else if (workoutType === 'threshold') paceMinPerKm = baseMinPerKm * 0.82;
        else if (workoutType === 'vo2') paceMinPerKm = baseMinPerKm * 0.73;
        else if (workoutType === 'race_pace') paceMinPerKm = baseMinPerKm * 0.78;
        else if (workoutType === 'marathon_pace') paceMinPerKm = baseMinPerKm * 0.87;
        dur = km * paceMinPerKm + wucdMin;
      } else {
        // Try simple "45min"
        const simpleMatch = mainDesc.match(/(\d+)min/);
        if (simpleMatch) {
          dur = parseInt(simpleMatch[1]) + wucdMin;
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
