import type { SportKey, CrossActivity, IntensityProfile } from '@/types';
import { SPORTS_DB, SPORT_ALIASES, RPE_MULT, ANAEROBIC_WEIGHT, RPE_WEIGHT, DEFAULT_RPE, LOAD_PER_MIN_BY_INTENSITY } from '@/constants';
import { generateId } from '@/utils';

/**
 * Normalize sport name to standard key
 * @param name - Raw sport name
 * @returns Normalized sport key
 */
export function normalizeSport(name: string): SportKey {
  const clean = name.toLowerCase().trim().replace(/ /g, '_');
  return (SPORT_ALIASES[clean] || clean) as SportKey;
}

/**
 * Get RPE multiplier for load calculation
 * @param rpe - RPE value (1-10)
 * @returns Multiplier
 */
export function getRPEMult(rpe: number): number {
  for (const threshold of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    if (rpe >= threshold) return RPE_MULT[threshold];
  }
  return 1.0;
}

/**
 * Calculate RPE factor for load adjustment
 * @param rpe - RPE value (1-10)
 * @returns Factor
 */
export function rpeFactor(rpe: number | null | undefined): number {
  const r = rpe || DEFAULT_RPE;
  return 1.0 + (r - DEFAULT_RPE) * RPE_WEIGHT;
}

/**
 * Calculate weighted load from aerobic and anaerobic
 * @param aerobic - Aerobic load
 * @param anaerobic - Anaerobic load
 * @returns Weighted load
 */
export function weightedLoad(aerobic: number, anaerobic: number): number {
  return aerobic + ANAEROBIC_WEIGHT * anaerobic;
}

/**
 * Get intensity profile from aerobic/anaerobic loads
 * @param aerobic - Aerobic load
 * @param anaerobic - Anaerobic load
 * @returns Intensity profile
 */
export function intensityProfile(aerobic: number, anaerobic: number): IntensityProfile {
  const total = aerobic + anaerobic;
  const ratio = total <= 0 ? 0 : anaerobic / total;
  const weighted = weightedLoad(aerobic, anaerobic);
  return { total, anaerobicRatio: ratio, weighted };
}

/**
 * Check if activity qualifies as a hard day
 * @param aerobic - Aerobic load
 * @param anaerobic - Anaerobic load
 * @returns True if hard day
 */
export function isHardDay(aerobic: number, anaerobic: number): boolean {
  const profile = intensityProfile(aerobic, anaerobic);
  return profile.anaerobicRatio >= 0.22 || profile.weighted >= 40;
}

/**
 * Check if sport can modify a workout type
 * @param sportKey - Sport key
 * @param workoutType - Workout type
 * @returns True if can touch
 */
export function canTouchWorkout(sportKey: SportKey, workoutType: string): boolean {
  const sp = SPORTS_DB[sportKey];
  if (!sp) return true;
  const wt = workoutType.toLowerCase();
  return !sp.noReplace.some(nr => nr.toLowerCase() === wt);
}

/**
 * Create a cross-training activity
 * @param sport - Sport name
 * @param durationMin - Duration in minutes
 * @param rpe - RPE (1-10)
 * @param aerobicLoad - Aerobic load (optional, will estimate if not provided)
 * @param anaerobicLoad - Anaerobic load (optional)
 * @param week - Week number
 * @returns CrossActivity object
 */
export function createActivity(
  sport: string,
  durationMin: number,
  rpe: number,
  aerobicLoad?: number,
  anaerobicLoad?: number,
  week: number = 1
): CrossActivity {
  const normalizedSport = normalizeSport(sport);

  // Use Garmin loads if provided, otherwise estimate
  let aerobic_load: number;
  let anaerobic_load: number;
  const fromGarmin = !!(aerobicLoad && aerobicLoad > 0);

  if (fromGarmin) {
    aerobic_load = aerobicLoad!;
    anaerobic_load = anaerobicLoad || 0;
  } else {
    // Estimate in Garmin scale using calibrated rates
    const baseRate = LOAD_PER_MIN_BY_INTENSITY[rpe] || 2.0;
    aerobic_load = durationMin * baseRate * 0.85;
    anaerobic_load = rpe > 7 ? durationMin * baseRate * 0.15 : durationMin * baseRate * 0.05;
  }

  return {
    id: generateId(),
    date: new Date(),
    week,
    sport: normalizedSport,
    duration_min: durationMin,
    rpe,
    aerobic_load,
    anaerobic_load,
    dayOfWeek: new Date().getDay(),
    aerobic: aerobic_load,
    anaerobic: anaerobic_load,
    fromGarmin,
    applied: false,
    renderCycle: -1
  };
}

/**
 * Calculate total weekly load from activities
 * @param activities - Array of activities
 * @param week - Week to filter by
 * @returns Total weekly load
 */
export function getWeeklyLoad(activities: CrossActivity[], week: number): number {
  return activities
    .filter(a => a.week === week)
    .reduce((sum, a) => {
      const sportData = SPORTS_DB[normalizeSport(a.sport)] || { mult: 1.0 };
      let load = a.aerobic_load + (a.anaerobic_load || 0) * ANAEROBIC_WEIGHT;
      load *= sportData.mult;
      load *= getRPEMult(a.rpe);
      return sum + load;
    }, 0);
}

/**
 * Aggregate activities from current and previous weeks
 * @param allActivities - All cross-training activities
 * @param currentWeek - Current week number
 * @returns Object with current and previous week activities separated
 */
export function aggregateActivitiesWithDecay(
  allActivities: CrossActivity[],
  currentWeek: number
): { current: CrossActivity[]; previous: CrossActivity[]; } {
  const current = allActivities.filter(a => a.week === currentWeek);
  const previous = allActivities.filter(a => a.week === currentWeek - 1);

  return { current, previous };
}
