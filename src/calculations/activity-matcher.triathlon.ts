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

import type { Week, Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { DAY_NAMES } from '@/workouts/scheduler.triathlon';

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

/**
 * Reconcile one week's tri/cycling completion state with its stored actuals.
 * Pure local mutation of `wk`; returns true when anything changed.
 *
 * Responsibilities (all tracking — describing what happened):
 *   1. Backfill a missing `startTime` on an actual from its raw pending record
 *      (older applyReview wrote cross-matched actuals without one, which broke
 *      Recent's sort and every day-of-week derivation downstream).
 *   2. Direct-bind: an actual stored under a slot's own key IS that slot's
 *      completion — the matching screen put it there. Never re-matched fuzzily.
 *   3. Clear stale completions: a `matchedActivityId` whose actual no longer
 *      exists (re-review undid it), or one pointing at a recording the user
 *      explicitly placed as an extra/excess session (`garmin-…` adhoc key in
 *      `garminMatched`). The launch-time fuzzy matcher must not override a
 *      matching-screen decision.
 *   4. Day shift: a completed slot moves to the weekday the session actually
 *      happened (actuals live in this week by construction, so the weekday of
 *      `startTime` is the right axis). A ride planned Thursday but ridden
 *      Wednesday shows under Wednesday.
 */
export function reconcileTriCompletions(wk: Week): boolean {
  const workouts = wk.triWorkouts ?? [];
  if (workouts.length === 0) return false;
  const actuals = wk.garminActuals ?? {};
  const rated = wk.rated ?? {};
  const matched = wk.garminMatched ?? {};
  let changed = false;

  // 1. startTime backfill from the raw pending record
  for (const a of Object.values(actuals)) {
    if (a.startTime || !a.garminId) continue;
    const p = wk.garminPending?.find(x => x.garminId === a.garminId);
    if (p?.startTime) { a.startTime = p.startTime; changed = true; }
  }

  // 1b. Orphaned adhoc twin: a `garmin-…`-keyed actual whose recording the user
  // has since moved onto a plan slot (garminMatched points at the slot, and the
  // slot carries the same garminId). The leftover copy double-counts and can be
  // re-claimed by the fuzzy matcher — drop it.
  for (const [key, a] of Object.entries(actuals)) {
    if (!key.startsWith('garmin-') || !a.garminId) continue;
    const placed = matched[a.garminId];
    if (!placed || placed === key || placed === '__pending__') continue;
    if (actuals[placed]?.garminId === a.garminId) {
      delete actuals[key];
      if (wk.adhocWorkouts) wk.adhocWorkouts = wk.adhocWorkouts.filter(x => x.id !== key);
      changed = true;
    }
  }

  for (const w of workouts) {
    const id = w.id ?? w.n;

    const direct = actuals[id];
    if (direct?.garminId) {
      // 2. Direct bind
      if (w.status !== 'completed') { w.status = 'completed'; changed = true; }
      if (w.matchedActivityId !== id) { w.matchedActivityId = id; changed = true; }
    } else if (w.matchedActivityId) {
      const link = w.matchedActivityId;
      const target = actuals[link];
      const userDecidedAdhoc = !!target?.garminId
        && link.startsWith('garmin-')
        && matched[target.garminId] === link;
      const stale = !target && typeof rated[id] !== 'number';
      if (stale || userDecidedAdhoc) {
        // 3. Stale or user-overridden link
        delete w.matchedActivityId;
        if (w.status === 'completed') w.status = 'planned';
        changed = true;
      }
    }

    // 4. Day shift for completed slots
    if (w.status !== 'completed' || !w.matchedActivityId) continue;
    const a = actuals[w.matchedActivityId];
    if (!a?.startTime) continue;
    const t = new Date(a.startTime);
    if (isNaN(t.getTime())) continue;
    const actualDay = (t.getDay() + 6) % 7; // Mon=0..Sun=6
    if (w.dayOfWeek !== actualDay) {
      w.dayOfWeek = actualDay;
      w.dayName = DAY_NAMES[actualDay];
      changed = true;
    }
  }

  return changed;
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
