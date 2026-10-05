/**
 * Apple/Strava duplicate cleanup for Strava-connected users.
 *
 * Since 2026-10-05 Apple Health workouts are not ingested while Strava is
 * connected (`appleWorkoutsEnabled` in sources.ts). Installs that ran Apple next
 * to Strava before that already hold Apple copies of sessions Strava also
 * recorded, and those count twice. Two parts:
 *
 *   - Local collapse (`collapseAppleStravaTwins`), every time, while Strava owns
 *     workouts: at launch before the network syncs
 *     (`collapseAppleStravaTwinsOnLaunch`) and after each launch Strava sync
 *     (`finishAppleStravaTwinCleanup`). Idempotent and local, so it never needs
 *     a done flag. A Strava twin can land late (a failed sync, or a row that
 *     only arrives through the later garmin_activities pass), and a paused
 *     session's twins differ by more than the 15% the upgrade loop and the
 *     reconcile accept, so a one-shot pass would leave that pair counted twice.
 *     matchAndAutoComplete runs the same collapse after every batch that carries
 *     Strava rows, so a late twin goes in the same session.
 *   - The garmin_activities twin cleanup, once: the first post-sync pass sets
 *     `appleStravaTwinCleanupDone` and forces `cleanupDbDuplicates` whatever its
 *     30-day cadence. No new Apple rows reach garmin_activities while Strava is
 *     connected, so one forced pass is enough; if it fails before stamping,
 *     the cleared stamp makes the regular launch gate retry.
 *
 * **Side of the line**: tracking (which records describe what the user did).
 */

import { getMutableState, saveState } from '@/state';
import { appleWorkoutsEnabled } from '@/data/sources';
import { collapseAppleStravaTwins } from '@/calculations/cross-source-twins';
import { cleanupDbDuplicates } from '@/data/stravaSync';

/** Same window the launch-time DB cleanup in main.ts uses. */
const DB_TWIN_CLEANUP_DAYS = 90;

/** Local collapse while Strava owns workouts. Returns true when it removed anything. */
function collapseLocalTwins(): boolean {
  const s = getMutableState();
  if (appleWorkoutsEnabled(s)) return false;
  const { removed } = collapseAppleStravaTwins(s);
  if (removed.length > 0) saveState();
  return removed.length > 0;
}

/** Launch pass, before the network syncs. Returns true when it removed anything. */
export function collapseAppleStravaTwinsOnLaunch(): boolean {
  return collapseLocalTwins();
}

/** Pass after a launch Strava sync. Collapses late twins every time; forces the
 *  garmin_activities twin cleanup once. Returns true when it removed anything. */
export async function finishAppleStravaTwinCleanup(): Promise<boolean> {
  const changed = collapseLocalTwins();
  const s = getMutableState();
  if (appleWorkoutsEnabled(s) || s.appleStravaTwinCleanupDone) return changed;
  s.appleStravaTwinCleanupDone = true;
  // Clearing the stamp makes the regular launch gate retry the DB cleanup if this
  // run fails before it stamps (offline, no session).
  delete s.dbDedupCompletedAt;
  saveState();
  await cleanupDbDuplicates(DB_TWIN_CLEANUP_DAYS).catch(() => undefined);
  return changed;
}
