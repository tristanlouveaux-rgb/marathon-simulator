import type { Week } from '@/types';
import { formatActivityType } from '@/calculations/activity-matcher';
import { isExtraActivityKey } from '@/calculations/in-app-activity';

/**
 * Canonical "what the user actually did this week" list.
 *
 * Logged activities live in three places on a Week, and every surface that
 * shows "what happened" (home recent-activity feed, running plan Activity Log,
 * triathlon/cycling completed efforts, HYROX activity log) must read the SAME
 * set or they diverge — an activity shows on one screen and silently vanishes
 * on another. That divergence is exactly the bug this module exists to kill:
 * the running plan + home page showed unmatched/logged/pending activities, but
 * the triathlon past-week view only showed planned slots that matched, and
 * HYROX showed nothing.
 *
 * The three sources, and how they dedup, mirror the original running
 * `buildActivityLog` logic 1:1:
 *   1. `garminActuals`  — keyed by planned-workout id when matched ("Matched"),
 *      or by `garmin-<id>` when the activity has no plan slot ("Logged"). An
 *      orphaned `garmin-*` actual flagged in `unspentLoadItems` reads "Excess".
 *   2. `adhocWorkouts`  — entries whose id starts `garmin-` (logged standalone
 *      activities). Deduped against `garminActuals` so the same activity is
 *      counted once.
 *   3. `garminPending`  — synced activities not yet reviewed/assigned.
 *
 * Each mode renders these entries in its own visual style; only the gathering
 * and dedup lives here. If you change this, the running `buildActivityLog`
 * renderer and the tri/HYROX consumers all follow automatically.
 */

export type WeekActivityBadge = 'matched' | 'logged' | 'excess' | 'pending';
export type ActivityDiscipline = 'run' | 'bike' | 'swim' | null;

export interface WeekActivityEntry {
  badge: WeekActivityBadge;
  /** Activity display name (e.g. "Easy Run", "Cycling", "Open Water Swim"). */
  name: string;
  /** Matched planned-slot name, when the activity matched a plan workout and the
   *  slot name differs from the activity name. Used for the "→ Easy Run" suffix. */
  slotName: string | null;
  discipline: ActivityDiscipline;
  durationMin: number;
  distanceKm: number;
  paceSecPerKm: number | null;
  avgHR: number | null;
  /** ms epoch for sorting (newest first). 0 when no timestamp is available. */
  sortTime: number;
  /** Stable identity for dedup across surfaces. For matched/logged actuals this is
   *  the `garminActuals` key; for adhoc it is the adhoc workout id; for pending it
   *  is `pending-<garminId>`. */
  key: string;
  /** Underlying activity id (Garmin/Strava), when known. Drives the remove control. */
  garminId: string | null;
  source: 'actual' | 'adhoc' | 'pending';
}

/** Map any free-text sport / activity-type string to a triathlon discipline.
 *  Mirrors `disciplineFor` in activity-matcher.triathlon.ts (kept local to avoid
 *  importing the whole matcher into the UI layer). Returns null when unknown. */
export function disciplineFromType(raw: string | null | undefined): ActivityDiscipline {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s === 'run' || s.includes('run')) return 'run';
  if (s.includes('bike') || s.includes('cycl') || s.includes('ride')) return 'bike';
  if (s.includes('swim')) return 'swim';
  return null;
}

const PENDING_APPTYPE_DISCIPLINE: Record<string, ActivityDiscipline> = {
  ride: 'bike',
  swim: 'swim',
};

/**
 * Gather and dedup every logged activity for one week, newest first.
 * Pure: reads only the Week's stored actuals/adhoc/pending and returns plain data.
 */
export function collectWeekActivities(wk: Week | undefined): WeekActivityEntry[] {
  if (!wk) return [];
  const actuals = wk.garminActuals || {};
  const adhocGarmin = (wk.adhocWorkouts || []).filter((w: any) => (w.id || '').startsWith('garmin-'));
  const adhocGarminIds = new Set(adhocGarmin.map((w: any) => w.id || ''));
  const garminMatched = wk.garminMatched || {};
  const pendingItems = (wk.garminPending || []).filter(p => garminMatched[p.garminId] === '__pending__');
  const excessGarminIds = new Set((wk.unspentLoadItems || []).map((u: any) => u.garminId));

  const entries: WeekActivityEntry[] = [];

  // 1. garminActuals. Plan-slot matches → "Matched"; orphaned garmin-* (adhoc
  //    removed via ×) → "Logged"/"Excess". Skip garmin-* keys that still have a
  //    live adhoc workout — the adhoc loop renders those with the correct badge.
  for (const [workoutId, raw] of Object.entries(actuals)) {
    if (workoutId.startsWith('garmin-') && adhocGarminIds.has(workoutId)) continue;
    const a = raw as any;
    // No plan slot behind it: a standalone synced activity, or an actual keyed
    // by a done (non-planned) adhoc id, such as an in-app GPS run recorded
    // outside the plan. Decided by the key, not the source, so the run stays
    // "Logged" after a watch copy supersedes the in-app record under that key.
    // isExtraActivityKey is the same rule the cross-source reconcile uses.
    const isOrphan = isExtraActivityKey(wk, workoutId);
    const name = a.displayName || a.workoutName || workoutId;
    const slotName = !isOrphan && a.workoutName && a.workoutName !== a.displayName ? a.workoutName : null;
    const isExcess = workoutId.startsWith('garmin-') && excessGarminIds.has(workoutId.slice('garmin-'.length));
    entries.push({
      badge: isOrphan ? (isExcess ? 'excess' : 'logged') : 'matched',
      name,
      slotName,
      discipline: disciplineFromType(a.manualSport || a.activityType || a.workoutName || name),
      durationMin: a.durationSec ? Math.round(a.durationSec / 60) : 0,
      distanceKm: a.distanceKm || 0,
      paceSecPerKm: a.avgPaceSecKm ?? null,
      avgHR: a.avgHR ?? null,
      sortTime: a.startTime ? new Date(a.startTime).getTime() : 0,
      key: workoutId,
      garminId: a.garminId ?? null,
      source: 'actual',
    });
  }

  // 2. Adhoc garmin/strava activities (logged standalone, or excess overload).
  for (const w of adhocGarmin) {
    const a = w as any;
    const rawId = (a.id || '').slice('garmin-'.length);
    const km = a.garminDistKm || a.km || a.distanceKm || 0;
    const dur = a.garminDurationMin || a.dur || 0;
    const pace = a.garminDistKm > 0.1 && a.garminDurationMin > 0
      ? Math.round((a.garminDurationMin * 60) / a.garminDistKm)
      : null;
    const time = a.garminTimestamp || a.startTime;
    entries.push({
      badge: excessGarminIds.has(rawId) ? 'excess' : 'logged',
      name: a.n || 'Activity',
      slotName: null,
      discipline: disciplineFromType(a.manualSport || a.activityType || a.t || a.n),
      durationMin: typeof dur === 'number' ? dur : parseFloat(dur) || 0,
      distanceKm: typeof km === 'number' ? km : parseFloat(km) || 0,
      paceSecPerKm: pace,
      avgHR: a.garminAvgHR ?? null,
      sortTime: time ? new Date(time).getTime() : 0,
      key: a.id || rawId,
      garminId: rawId || null,
      source: 'adhoc',
    });
  }

  // 3. Pending (synced, not yet reviewed/assigned).
  for (const p of pendingItems) {
    entries.push({
      badge: 'pending',
      name: formatActivityType(p.activityType),
      slotName: null,
      discipline: disciplineFromType(p.activityType) ?? PENDING_APPTYPE_DISCIPLINE[p.appType] ?? null,
      durationMin: p.durationSec ? Math.round(p.durationSec / 60) : 0,
      distanceKm: (p.distanceM ?? 0) / 1000,
      paceSecPerKm: p.avgPaceSecKm ?? null,
      avgHR: p.avgHR ?? null,
      sortTime: p.startTime ? new Date(p.startTime).getTime() : 0,
      key: `pending-${p.garminId}`,
      garminId: p.garminId,
      source: 'pending',
    });
  }

  entries.sort((a, b) => b.sortTime - a.sortTime);
  return entries;
}
