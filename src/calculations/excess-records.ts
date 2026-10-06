/**
 * Excess-load records (wk.unspentLoadItems) and the activity ids that name them.
 *
 * An excess record is either an overflow item keyed by the activity's garminId or
 * a surplus slice keyed `${garminId}_surplus` (the part of a matched run beyond
 * its planned distance). Load totals never read these records; the excess card,
 * the "Adjust week" button and the ACWR reduction modal do. So a record left
 * behind after its activity is removed, unassigned or re-reviewed keeps offering
 * to cut the plan for load that is no longer there, and a record written twice
 * doubles the extra load those surfaces report (audit B19).
 *
 * Tracking-side bookkeeping only: no load or prediction number reads it.
 */

import type { Week, UnspentLoadItem } from '@/types';

/** Shared by every unassigned activity, so it names none of them. */
const PENDING = '__pending__';

/**
 * Every id that names one activity in a week:
 *   - the garminId given;
 *   - the suffix of a `garmin-<id>` workout id the activity is filed under;
 *   - every other garminMatched key filed under the same workout id.
 * The Strava upgrade rewrites an actual's garminId to strava-<id> but keeps its
 * key garmin-<oldId> and the old garminMatched entry, while excess records keep
 * the id the activity had when they were written, so all of these can name it.
 *
 * Call before any garminMatched entry for the activity is changed.
 * `workoutId` defaults to the activity's current garminMatched value.
 */
export function collectActivityAliases(
  wk: Week | undefined,
  garminId: string,
  workoutId: string | undefined = wk?.garminMatched?.[garminId],
): Set<string> {
  const ids = new Set<string>([garminId]);
  if (!wk || !workoutId || workoutId === PENDING) return ids;
  if (workoutId.startsWith('garmin-')) ids.add(workoutId.slice('garmin-'.length));
  for (const [gid, wid] of Object.entries(wk.garminMatched ?? {})) {
    if (wid === workoutId) ids.add(gid);
  }
  return ids;
}

/**
 * Drop the overflow item and the surplus slice of each activity id from the given
 * weeks. Returns true when anything was removed.
 */
export function scrubExcessRecords(weeks: Array<Week | undefined>, activityIds: Iterable<string>): boolean {
  const ids = new Set<string>();
  for (const id of activityIds) {
    ids.add(id);
    ids.add(`${id}_surplus`);
  }
  let changed = false;
  for (const wk of weeks) {
    if (!wk?.unspentLoadItems?.some(u => ids.has(u.garminId))) continue;
    wk.unspentLoadItems = wk.unspentLoadItems.filter(u => !ids.has(u.garminId));
    changed = true;
  }
  return changed;
}

/**
 * Append an excess record unless one with the same garminId is already there
 * (the dedup populateUnspentLoadItems applies to overflow items). Returns true
 * when the record was added, so the caller bumps any running total only once.
 */
export function addUnspentItemOnce(wk: Week, item: UnspentLoadItem): boolean {
  if ((wk.unspentLoadItems ?? []).some(u => u.garminId === item.garminId)) return false;
  wk.unspentLoadItems = [...(wk.unspentLoadItems ?? []), item];
  return true;
}
