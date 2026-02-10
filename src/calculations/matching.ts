/**
 * Smart Sync — Workout Matching Logic
 *
 * Matches incoming external activities (e.g. from Strava) against the
 * current week's planned workouts using day, distance, and type heuristics.
 */

import type { Workout } from '@/types';

/** Incoming activity from an external source */
export interface ExternalActivity {
  type: 'run' | 'ride' | 'swim' | 'walk' | 'other';
  distanceKm: number;
  durationMin: number;
  dayOfWeek: number;       // 0=Mon, 6=Sun
  name?: string;
  avgPaceSecPerKm?: number;
  avgHR?: number;
}

/** Result of a successful match */
export interface MatchResult {
  matchFound: true;
  workoutName: string;
  confidence: 'high' | 'medium';
  reason: string;
}

/** Workout types that count as "run" activities */
const RUN_WORKOUT_TYPES = new Set([
  'easy', 'long', 'threshold', 'vo2', 'intervals',
  'marathon_pace', 'race_pace', 'mixed', 'progressive', 'test_run',
]);

/**
 * Try to match an external activity to a planned workout.
 *
 * Heuristic layers:
 *  1. Same day (or +/-1 day)
 *  2. Distance within +/-15%
 *  3. Activity type roughly matches workout type
 *
 * Returns a MatchResult or null if no match found.
 */
export function findMatchingWorkout(
  activity: ExternalActivity,
  weeklyPlan: Workout[],
): MatchResult | null {
  // Only match run activities against run workouts
  const isRun = activity.type === 'run' || activity.type === 'walk';

  // Filter to unrated, matchable workouts
  const candidates = weeklyPlan.filter(w => {
    if (w.status === 'replaced') return false;
    // Run activities match run workouts; non-run activities don't match
    if (isRun) return RUN_WORKOUT_TYPES.has(w.t);
    return false;
  });

  if (candidates.length === 0) return null;

  // Score each candidate
  let bestMatch: { workout: Workout; score: number; reasons: string[] } | null = null;

  for (const w of candidates) {
    let score = 0;
    const reasons: string[] = [];

    // --- Day match ---
    if (w.dayOfWeek !== undefined) {
      if (w.dayOfWeek === activity.dayOfWeek) {
        score += 3;
        reasons.push('same day');
      } else if (Math.abs(w.dayOfWeek - activity.dayOfWeek) === 1 ||
        Math.abs(w.dayOfWeek - activity.dayOfWeek) === 6) {
        score += 1;
        reasons.push('adjacent day');
      }
    }

    // --- Distance match ---
    const plannedKm = parseDistanceKm(w.d);
    if (plannedKm > 0 && activity.distanceKm > 0) {
      const ratio = activity.distanceKm / plannedKm;
      if (ratio >= 0.85 && ratio <= 1.15) {
        score += 3;
        reasons.push(`distance within 15% (${activity.distanceKm.toFixed(1)} vs ${plannedKm.toFixed(1)}km)`);
      } else if (ratio >= 0.7 && ratio <= 1.3) {
        score += 1;
        reasons.push('distance roughly similar');
      }
    }

    // --- Type affinity ---
    if (isRun && RUN_WORKOUT_TYPES.has(w.t)) {
      score += 1;
      reasons.push('type match (run)');
    }

    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { workout: w, score, reasons };
    }
  }

  if (!bestMatch) return null;

  // Confidence thresholds
  const confidence: 'high' | 'medium' = bestMatch.score >= 5 ? 'high' : 'medium';

  // Require at least score 3 (day match + something, or distance match + something)
  if (bestMatch.score < 3) return null;

  return {
    matchFound: true,
    workoutName: bestMatch.workout.n,
    confidence,
    reason: bestMatch.reasons.join(', '),
  };
}

/**
 * Parse a workout description string to extract total distance in km.
 * Handles formats like "14km easy", "6 x 800m", "10km @ MP", etc.
 */
function parseDistanceKm(description: string): number {
  // Direct km match: "14km", "10.5km", "14 km"
  const kmMatch = description.match(/(\d+(?:\.\d+)?)\s*km/i);
  if (kmMatch) return parseFloat(kmMatch[1]);

  // Miles match: "8 miles"
  const miMatch = description.match(/(\d+(?:\.\d+)?)\s*mi(?:le)?s?/i);
  if (miMatch) return parseFloat(miMatch[1]) * 1.609;

  // Interval: "6 x 800m" → approximate total = reps * dist + rest jog
  const intervalMatch = description.match(/(\d+)\s*x\s*(\d+)\s*m/i);
  if (intervalMatch) {
    const reps = parseInt(intervalMatch[1]);
    const distM = parseInt(intervalMatch[2]);
    // Rough: total = reps * interval distance * 2 (including jog recovery) + warm/cool ~3km
    return (reps * distM * 2) / 1000 + 3;
  }

  return 0;
}
