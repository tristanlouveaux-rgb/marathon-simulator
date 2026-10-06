/**
 * Smart Sync. Workout Matching Logic
 *
 * Matches incoming external activities (e.g. from Strava/Garmin) against the
 * current week's planned workouts using day, distance, and type heuristics.
 */

import type { Workout } from '@/types';
import { isLongRun } from '@/workouts/long-run';

/** Incoming activity from an external source */
export interface ExternalActivity {
  type: 'run' | 'gym' | 'ride' | 'swim' | 'walk' | 'other';
  distanceKm: number;
  durationMin: number;
  dayOfWeek: number;       // 0=Mon, 6=Sun
  name?: string;
  avgPaceSecPerKm?: number;
  avgHR?: number;
  stream?: import('./stream-processor').ActivityStream;
}

/** Result of a successful match */
export interface MatchResult {
  matchFound: true;
  workoutName: string;
  workoutId: string;           // The w.id || w.n value used in wk.rated
  matchedWorkout: Workout;     // Reference to matched workout
  confidence: 'high' | 'medium';
  reason: string;
}

/** Workout types that count as "run" activities */
const RUN_WORKOUT_TYPES = new Set([
  'easy', 'long', 'threshold', 'vo2', 'intervals',
  'marathon_pace', 'race_pace', 'mixed', 'progressive', 'test_run',
]);

/**
 * A planned running slot: the running engine's run types, plus HYROX's run
 * sessions (`hyrox_run_easy` / `_tempo` / `_intervals`, hyrox-generators.ts),
 * which live in wk.triWorkouts next to the station and brick sessions.
 */
export function isRunSlot(w: Pick<Workout, 't'>): boolean {
  const t = w.t ?? '';
  return RUN_WORKOUT_TYPES.has(t) || t.startsWith('hyrox_run_');
}

/**
 * Activity classes that can fill a planned running slot: runs only.
 *
 * The 'walk' class (mapGarminType: walking, hiking, wheelchair, paddleboarding,
 * rowing, kayaking, canoe, golf) is never run-compatible. A walk or a row is not
 * the prescribed run, so it cannot complete a planned Easy, Long or Threshold
 * run (audit D3). It fills a cross slot by sport name, like any other sport,
 * and otherwise counts as cross-training load.
 *
 * Tracking side: this decides which planned slot a recorded activity is filed
 * against. It changes no load number.
 */
export function isRunClassActivity(type: string): boolean {
  return type === 'run';
}

/** Run-slot types beyond isRunSlot that the matching screen lets a run fill. */
const EXTRA_RUN_SLOT_TYPES = new Set(['run', 'steady', 'float']);

/**
 * The one compatibility rule between a synced activity (its matcher app type:
 * run / gym / ride / swim / walk / other) and a planned slot. Used by the
 * auto-match paths, the matching screen's pre-assignment and its manual taps,
 * so no path can file an activity where a manual tap would be refused.
 *
 *  - run   → any run slot (incl. the fast-finish long run and HYROX run
 *            sessions), a generic cross slot, or a tri brick.
 *  - gym   → a gym slot, or a HYROX station / brick session.
 *  - ride  → a cross slot, a tri brick or any tri bike slot.
 *  - swim  → a cross slot or any tri swim slot.
 *  - walk, other → a cross slot only. Never a run slot (audit D3).
 */
export function isActivityCompatibleWithSlot(
  appType: string,
  workout: Pick<Workout, 't'> & { longRun?: boolean; discipline?: string },
): boolean {
  const wt = workout.t ?? '';
  if (isRunClassActivity(appType)) {
    return isRunSlot(workout) || isLongRun(workout) || EXTRA_RUN_SLOT_TYPES.has(wt) || wt === 'cross' || wt === 'brick';
  }
  if (appType === 'gym') return wt === 'gym' || workout.discipline === 'station' || workout.discipline === 'brick';
  if (appType === 'ride') return wt === 'cross' || wt === 'brick' || wt.startsWith('bike_');
  if (appType === 'swim') return wt === 'cross' || wt.startsWith('swim_');
  return wt === 'cross';
}

/**
 * Try to match an external activity to a planned workout.
 *
 * Heuristic layers:
 *  1. Same day (or +/-1 day). Relaxed: different-day matches still score but lower
 *  2. Distance within +/-15%
 *  3. Activity type roughly matches workout type
 *
 * Returns a MatchResult or null if no match found.
 */
export function findMatchingWorkout(
  activity: ExternalActivity,
  weeklyPlan: Workout[],
): MatchResult | null {
  // Walks, hikes, rows and the rest of the 'walk' class are never run-compatible
  // (isRunClassActivity, audit D3): like any other sport they fill a cross slot
  // only on a sport-name match.
  const isRun  = isRunClassActivity(activity.type);
  const isGym  = activity.type === 'gym';
  const isOther = activity.type === 'other' || activity.type === 'walk';

  // Filter to matchable workouts
  const candidates = weeklyPlan.filter(w => {
    if (w.status === 'replaced') return false;
    if (isRun)   return isRunSlot(w);
    if (isGym)   return w.t === 'gym';
    if (isOther) return w.t === 'cross';
    return false;
  });

  if (candidates.length === 0) return null;

  // Score each candidate
  let bestMatch: { workout: Workout; score: number; reasons: string[]; differentDay: boolean } | null = null;

  for (const w of candidates) {
    let score = 0;
    const reasons: string[] = [];
    let differentDay = false;

    // --- Day match ---
    if (w.dayOfWeek !== undefined) {
      if (w.dayOfWeek === activity.dayOfWeek) {
        score += 3;
        reasons.push('same day');
      } else if (Math.abs(w.dayOfWeek - activity.dayOfWeek) === 1 ||
        Math.abs(w.dayOfWeek - activity.dayOfWeek) === 6) {
        score += 1;
        reasons.push('adjacent day');
        differentDay = true;
      } else {
        // Different day. Still allow matching but flag it
        differentDay = true;
        reasons.push('different day');
      }
    }

    // --- Distance match (runs only) ---
    if (isRun) {
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
    }

    // --- Gym match ---
    if (isGym && w.t === 'gym') {
      score += 2;
      reasons.push('type match (gym)');
    }

    // --- Sport name match (for recurring cross-training activities) ---
    if (isOther && activity.name && w.n) {
      const actName  = activity.name.toLowerCase().trim();
      // Strip trailing number from plan name ("Tennis 2" → "tennis")
      const planName = w.n.toLowerCase().trim().replace(/\s+\d+$/, '');
      if (actName === planName || actName.startsWith(planName) || planName.startsWith(actName)) {
        score += 5;
        reasons.push(`sport match (${w.n})`);
      }
    }

    // --- Type affinity (runs) ---
    if (isRun && isRunSlot(w)) {
      score += 1;
      reasons.push('type match (run)');
    }

    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { workout: w, score, reasons, differentDay };
    }
  }

  if (!bestMatch) return null;

  // Minimum score: 2 for gym, 3 for runs, 5 for sport (requires name match)
  const minScore = isGym ? 2 : isOther ? 5 : 3;
  if (bestMatch.score < minScore) return null;

  // Different-day matches cap at medium confidence
  const confidence: 'high' | 'medium' =
    bestMatch.differentDay ? 'medium' :
    bestMatch.score >= 5 ? 'high' : 'medium';

  const w = bestMatch.workout;
  return {
    matchFound: true,
    workoutName: w.n,
    workoutId: w.id || w.n,
    matchedWorkout: w,
    confidence,
    reason: bestMatch.reasons.join(', '),
  };
}

/**
 * Parse a workout description string to extract total distance in km.
 * Handles formats like "14km easy", "6 x 800m", "10km @ MP", etc.
 */
export function parseDistanceKm(description: string): number {
  // Direct km match: "14km", "10.5km", "14 km"
  const kmMatch = description.match(/(\d+(?:\.\d+)?)\s*km/i);
  if (kmMatch) return parseFloat(kmMatch[1]);

  // Miles match: "8 miles", "1 mile", "5 mi". The unit must end the word, so the
  // "mi" of a minutes token ("10 min easy warm-up") is never read as miles.
  const miMatch = description.match(/(\d+(?:\.\d+)?)\s*mi(?:les?)?\b/i);
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
