/**
 * One-time Apple/Strava duplicate cleanup for Strava-connected users.
 *
 * Since 2026-10-05 Apple Health workouts are not ingested while Strava is
 * connected (`appleWorkoutsEnabled` in sources.ts). Installs that ran Apple next
 * to Strava before that already hold Apple copies of sessions Strava also
 * recorded, and those count twice. This removes them once:
 *
 *   - At launch, before the network syncs (`collapseAppleStravaTwinsOnLaunch`):
 *     collapses every twin whose Strava copy is already in state.
 *   - After the launch's Strava sync (`finishAppleStravaTwinCleanup`): one more
 *     pass, now that late Strava copies have landed, then the completion flag,
 *     then the garmin_activities twin cleanup (cleanupDbDuplicates) regardless of
 *     its 30-day cadence.
 *
 * Until the flag is set the launch pass repeats; it is idempotent and local.
 *
 * **Side of the line**: tracking (which records describe what the user did).
 */

import { getMutableState, saveState } from '@/state';
import { appleWorkoutsEnabled } from '@/data/sources';
import { collapseAppleStravaTwins } from '@/calculations/cross-source-twins';
import { cleanupDbDuplicates } from '@/data/stravaSync';

/** Same window the launch-time DB cleanup in main.ts uses. */
const DB_TWIN_CLEANUP_DAYS = 90;

/** Launch pass. Returns true when it removed anything. */
export function collapseAppleStravaTwinsOnLaunch(): boolean {
  const s = getMutableState();
  if (appleWorkoutsEnabled(s) || s.appleStravaTwinCleanupDone) return false;
  const { removed } = collapseAppleStravaTwins(s);
  if (removed.length > 0) saveState();
  return removed.length > 0;
}

/** Final pass after the launch's Strava sync. Returns true when it removed anything. */
export async function finishAppleStravaTwinCleanup(): Promise<boolean> {
  const s = getMutableState();
  if (appleWorkoutsEnabled(s) || s.appleStravaTwinCleanupDone) return false;
  const { removed } = collapseAppleStravaTwins(s);
  s.appleStravaTwinCleanupDone = true;
  // Clearing the stamp makes the regular launch gate retry the DB cleanup if this
  // run fails before it stamps (offline, no session).
  delete s.dbDedupCompletedAt;
  saveState();
  await cleanupDbDuplicates(DB_TWIN_CLEANUP_DAYS).catch(() => undefined);
  return removed.length > 0;
}
