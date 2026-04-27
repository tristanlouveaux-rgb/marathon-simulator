/**
 * Activity Sync — pulls Garmin activities from Supabase Edge Function
 * and triggers auto-completion of planned workouts.
 *
 * Fire-and-forget on boot. Offline-safe — silently no-ops on error.
 * Follows the same pattern as physiologySync.ts.
 */

import { callEdgeFunction } from './supabaseClient';
import {
  matchAndAutoComplete,
  type GarminActivityRow,
} from '@/calculations/activity-matcher';
import { render } from '@/ui/renderer';
import { getMutableState, saveState } from '@/state';
import { showActivityReview, autoProcessActivities } from '@/ui/activity-review';
import { reconcileRecentLegLoads } from '@/ui/sport-picker-modal';
import type { GarminLap } from '@/types';
import { mergeTimingMods } from '@/cross-training/timing-check';

/**
 * Fetch recent Garmin activities and match them to the current week's plan.
 * Safe to call at any time — silently no-ops on error so the app still loads.
 */
export async function syncActivities(): Promise<void> {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 28); // Look back 28 days

    const data = await callEdgeFunction<GarminActivityRow[]>(
      'sync-activities',
      { since: since.toISOString() },
    );

    const rows = Array.isArray(data) ? data : [];

    // Always check for stuck __pending__ items, even when no new rows arrive.
    // Without this, items queued in a previous sync never surface if the DB is empty.
    if (rows.length === 0) {
      if (!document.getElementById('activity-review-overlay') &&
          !document.getElementById('suggestion-modal')) {
        _pendingModalActive = false;
      }
      processPendingCrossTraining();
      return;
    }

    const result = matchAndAutoComplete(rows);

    // Backfill leg-load entries for newly synced runs + cross-training. Idempotent
    // (skips garminIds already in recentLegLoads). Required so freshly auto-matched
    // runs contribute to Leg Fatigue without waiting for the leg-load view to open.
    if (reconcileRecentLegLoads()) saveState();

    // Recompute timing downgrade mods after each sync
    const s2 = getMutableState();
    const wk2 = s2.wks?.[s2.w - 1];
    if (wk2 && mergeTimingMods(s2, wk2)) {
      saveState();
    }

    if (result.changed) {
      // New runs may unlock empirical LT detection — refresh derivation.
      try {
        const { recomputeLT } = await import('./ltSync');
        recomputeLT(s2);
        saveState();
      } catch { /* non-fatal */ }
      render();
    }

    console.log(`[ActivitySync] Processed ${rows.length} activities, ${result.pending.length} newly queued for modal`);

    // Reset the modal guard if no review or suggestion modal is currently open.
    // This unblocks a session where the user had previously cancelled the review
    // (or a suggestion modal was orphaned), leaving _pendingModalActive stuck at true.
    if (!document.getElementById('activity-review-overlay') &&
        !document.getElementById('suggestion-modal')) {
      _pendingModalActive = false;
    }

    // Show reduce/replace/keep modal — handles both newly queued AND pre-existing pending items
    processPendingCrossTraining();

    // After matching, fetch lap details for matched activities
    syncLapDetails().catch(() => {});
  } catch (err) {
    // Non-fatal — app continues without activity sync
    console.warn('[ActivitySync] Failed to sync:', err);
  }
}

// ---------------------------------------------------------------------------
// Pending cross-training review
/** Guard to prevent two concurrent review screens from running simultaneously */
let _pendingModalActive = false;

/** Reset the guard — called by stravaSync before processPendingCrossTraining */
export function resetPendingModalGuard(): void { _pendingModalActive = false; }

/**
 * Returns true when the pending items constitute a "backlog" that warrants
 * the full Activity Review screen rather than silent auto-processing.
 *
 * Batch = 3 or more items, OR any item is older than 24 hours.
 * Single same-day activities are silently auto-matched to slots.
 */
function isBatchSync(items: ReturnType<typeof getMutableState>['wks'][0]['garminPending']): boolean {
  if (!items || items.length === 0) return false;
  if (items.length >= 3) return true;
  // Runs always go to Activity Review so the user can match them to a plan slot
  if (items.some(i => i.appType === 'run')) return true;
  const oldest = items.reduce((a, b) => (a.startTime < b.startTime ? a : b));
  const ageMs = Date.now() - new Date(oldest.startTime).getTime();
  return ageMs > 24 * 60 * 60 * 1000;
}

/**
 * Process pending Garmin cross-training items.
 *
 * Routing:
 *  - Batch (≥3 items or any item >24h old) → Activity Review screen (user reviews each)
 *  - Single / same-day → auto-process silently (slot match → load modal only if overflow)
 */
export function processPendingCrossTraining(): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk?.garminPending?.length) return;
  if (_pendingModalActive) return;
  _pendingModalActive = true;

  // Compute current week date range so we only show this week's activities
  let weekStart: Date | undefined;
  let weekEnd: Date | undefined;
  if (s.planStartDate) {
    weekStart = new Date(s.planStartDate);
    weekStart.setDate(weekStart.getDate() + (s.w - 1) * 7);
    weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
  }

  // Drop malformed pending items (missing garminId, activityType, or startTime).
  // These can't be rendered or processed — carrying them forward just crashes the review UI.
  const beforeMalformed = wk.garminPending.length;
  wk.garminPending = wk.garminPending.filter(item =>
    !!item && !!item.garminId && !!item.activityType && !!item.startTime,
  );
  if (wk.garminPending.length !== beforeMalformed) {
    console.warn(`[ActivitySync] Dropped ${beforeMalformed - wk.garminPending.length} malformed pending item(s)`);
  }

  // Filter to items not yet reviewed AND from the current week
  const unprocessed = wk.garminPending.filter(item => {
    const matched = wk.garminMatched?.[item.garminId];
    if (matched && matched !== '__pending__') return false;
    if (weekStart && weekEnd) {
      const actDate = new Date(item.startTime);
      return actDate >= weekStart && actDate < weekEnd;
    }
    return true; // No planStartDate: include all unprocessed (legacy fallback)
  });

  if (unprocessed.length === 0) {
    _pendingModalActive = false;
    return;
  }

  const onReviewDone = () => {
    _pendingModalActive = false;
    render();
    // Retry any auto-debrief that was deferred because activities were unassigned
    // (see main.ts launch path + fireDebriefIfReady).
    import('@/ui/welcome-back').then(({ isWeekPendingDebrief }) => {
      import('@/ui/week-debrief').then(({ fireDebriefIfReady }) => {
        fireDebriefIfReady(isWeekPendingDebrief());
      });
    });
  };
  if (isBatchSync(unprocessed)) {
    // Backlog: show Activity Review so user can review each activity
    showActivityReview(unprocessed, onReviewDone);
  } else {
    // Flowing week: auto-match to slots, show load modal only for overflow
    autoProcessActivities(unprocessed, onReviewDone);
  }
}

/**
 * Open the excess load adjustment modal on-demand (called from "Adjust week" button).
 * Bypasses the ACWR check — used when the user explicitly requests adjustment
 * even when ACWR is not elevated.
 */
export function openAdjustWeekModal(): void {
  if (_pendingModalActive) return;
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk?.garminPending?.length) return;

  let weekStart: Date | undefined;
  let weekEnd: Date | undefined;
  if (s.planStartDate) {
    weekStart = new Date(s.planStartDate);
    weekStart.setDate(weekStart.getDate() + (s.w - 1) * 7);
    weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
  }

  const unprocessed = wk.garminPending.filter(item => {
    const matched = wk.garminMatched?.[item.garminId];
    if (matched && matched !== '__pending__') return false;
    if (weekStart && weekEnd) {
      const actDate = new Date(item.startTime);
      return actDate >= weekStart && actDate < weekEnd;
    }
    return true;
  });

  if (unprocessed.length === 0) return;

  _pendingModalActive = true;
  autoProcessActivities(unprocessed, () => {
    _pendingModalActive = false;
    render();
  }, true); // forceModal = true — bypass ACWR check
}

// ---------------------------------------------------------------------------

/** Raw lap shape from Garmin activity details */
interface RawLap {
  startTimeInSeconds?: number;
  totalDistanceInMeters?: number;
  timerDurationInSeconds?: number;
  averageRunCadenceInStepsPerMinute?: number;
  averageHeartRateInBeatsPerMinute?: number;
  averageSpeedInMetersPerSecond?: number;
}

/** Shape returned by the sync-activity-details Edge Function */
interface ActivityDetailRow {
  garmin_id: string;
  raw: {
    laps?: RawLap[];
    [key: string]: unknown;
  };
}

/**
 * Fetch activity details (lap splits) for Garmin-matched workouts that don't have laps yet.
 * Merges lap data into wk.garminActuals.
 */
async function syncLapDetails(): Promise<void> {
  try {
    const s = getMutableState();
    const wk = s.wks?.[s.w - 1];
    if (!wk?.garminActuals) return;

    // Find matched workouts missing lap data
    const garminIds: string[] = [];
    for (const actual of Object.values(wk.garminActuals)) {
      if (!actual.laps && actual.garminId) {
        garminIds.push(actual.garminId);
      }
    }
    if (garminIds.length === 0) return;

    const data = await callEdgeFunction<ActivityDetailRow[]>(
      'sync-activity-details',
      { garmin_ids: garminIds },
    );

    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return;

    let changed = false;
    for (const detail of rows) {
      if (!detail.raw?.laps || detail.raw.laps.length === 0) continue;

      // Find the matching actual entry
      for (const actual of Object.values(wk.garminActuals!)) {
        if (actual.garminId !== detail.garmin_id) continue;

        actual.laps = detail.raw.laps.map((lap: RawLap, i: number): GarminLap => {
          const distM = lap.totalDistanceInMeters ?? 0;
          const durSec = lap.timerDurationInSeconds ?? 0;
          const avgSpeed = lap.averageSpeedInMetersPerSecond ?? 0;
          const avgPaceSecKm = avgSpeed > 0 ? 1000 / avgSpeed : (distM > 0 ? (durSec / (distM / 1000)) : 0);
          return {
            index: i + 1,
            distanceM: distM,
            durationSec: durSec,
            avgPaceSecKm: Math.round(avgPaceSecKm),
            avgHR: lap.averageHeartRateInBeatsPerMinute,
          };
        });
        changed = true;
        console.log(`[ActivitySync] Parsed ${actual.laps.length} laps for ${detail.garmin_id}`);
        break;
      }
    }

    if (changed) {
      saveState();
      render();
    }
  } catch (err) {
    console.warn('[ActivitySync] Failed to sync lap details:', err);
  }
}
