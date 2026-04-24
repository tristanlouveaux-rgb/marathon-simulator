/**
 * Discipline-aware activity matcher for triathlon.
 *
 * Matches synced activities (Strava / Garmin / Apple Health) to the tri plan's
 * `triWorkouts` array. Runs independently from the running-mode matcher; the
 * running matcher keeps operating unchanged for run-only users.
 *
 * Matching rules:
 *   - Discipline must match first (swim → swim, bike → bike, run → run).
 *     Brick activities consist of two matches (see `matchBrickPair` below).
 *   - Within a discipline, match by nearest planned workout of the same
 *     day-of-week. Tolerate ±10% duration variance.
 *   - Fallback: if nothing on that day, match to any unmatched workout of
 *     the same discipline in the current week.
 *
 * **Side of the line**: tracking. Decides which planned workout a completed
 * activity "satisfies", so views can mark it complete and load contributions
 * can flow into per-discipline CTL.
 */

import type { Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';

export interface MatchableActivity {
  id: string;
  sport: string;              // Free form from the sync source
  startTs: number;            // Unix seconds
  durationSec: number;
  distanceM?: number;
  dayOfWeek?: number;         // 0=Mon..6=Sun (derived from startTs if absent)
}

export interface TriMatch {
  activityId: string;
  workoutId?: string;                        // Set when matched
  discipline: Discipline;
  confidence: 'high' | 'medium' | 'low';
  matched: boolean;
  reason?: string;
}

/**
 * Match a batch of activities against one week's tri workouts. Returns a
 * match per activity. `workouts` should be `week.triWorkouts` from state.
 */
export function matchTriathlonWeek(
  activities: MatchableActivity[],
  workouts: Workout[]
): TriMatch[] {
  const available: Workout[] = [...workouts];
  const matches: TriMatch[] = [];

  for (const a of activities) {
    const discipline = disciplineFor(a.sport);
    if (!discipline) {
      matches.push({
        activityId: a.id,
        discipline: 'run',
        confidence: 'low',
        matched: false,
        reason: 'unknown sport',
      });
      continue;
    }

    const dow = a.dayOfWeek ?? dayOfWeekFromTs(a.startTs);
    const candidates = available.filter((w) => (w.discipline ?? 'run') === discipline);

    if (candidates.length === 0) {
      matches.push({
        activityId: a.id,
        discipline,
        confidence: 'low',
        matched: false,
        reason: 'no planned workout of this discipline remaining',
      });
      continue;
    }

    // Prefer a same-day match
    const sameDay = candidates.filter((w) => w.dayOfWeek === dow);
    const pool = sameDay.length > 0 ? sameDay : candidates;

    // Pick the one whose planned duration is closest to the activity duration
    const best = pool.reduce((best, cur) => {
      const bestDelta = Math.abs(estimatePlannedDurationMin(best) * 60 - a.durationSec);
      const curDelta = Math.abs(estimatePlannedDurationMin(cur) * 60 - a.durationSec);
      return curDelta < bestDelta ? cur : best;
    });

    const plannedSec = estimatePlannedDurationMin(best) * 60;
    const ratio = plannedSec > 0 ? a.durationSec / plannedSec : 1;
    const confidence: TriMatch['confidence'] =
      (sameDay.length > 0 && Math.abs(ratio - 1) < 0.15) ? 'high'
        : Math.abs(ratio - 1) < 0.3 ? 'medium'
        : 'low';

    matches.push({
      activityId: a.id,
      workoutId: best.id,
      discipline,
      confidence,
      matched: true,
    });

    // Remove from pool so it isn't double-matched
    const idx = available.indexOf(best);
    if (idx >= 0) available.splice(idx, 1);
  }

  return matches;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function disciplineFor(sport: string): Discipline | null {
  const s = sport.toLowerCase();
  if (s === 'run' || s.includes('running')) return 'run';
  if (s.includes('bike') || s.includes('cycl') || s.includes('ride')) return 'bike';
  if (s.includes('swim')) return 'swim';
  return null;
}

function dayOfWeekFromTs(ts: number): number {
  const jsDay = new Date(ts * 1000).getDay();  // 0=Sun..6=Sat
  return (jsDay + 6) % 7;                       // → 0=Mon..6=Sun
}

/**
 * Estimate planned duration in minutes from a Workout's description. Looks
 * for "Nmin" patterns and returns the largest match (usually the main-set or
 * the whole-session duration).
 */
function estimatePlannedDurationMin(w: Workout): number {
  if (w.brickSegments) {
    return (w.brickSegments[0].durationMin ?? 0) + (w.brickSegments[1].durationMin ?? 0);
  }
  const matches = Array.from(w.d.matchAll(/(\d+)\s*min/g));
  if (!matches.length) return 60;
  return matches.reduce((acc, m) => Math.max(acc, parseInt(m[1], 10)), 0);
}
