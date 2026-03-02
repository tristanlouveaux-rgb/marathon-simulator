/**
 * stravaSync.ts
 * =============
 * Fetches Strava activities and feeds them into the standard matchAndAutoComplete()
 * pipeline. Strava is always the activity source when connected — regardless of
 * whether the user also has a Garmin or Apple Watch wearable.
 *
 * The wearable (Garmin/Apple) is used separately for biometrics only
 * (VO2max, LT, HRV, sleep) via syncPhysiologySnapshot().
 */

import { callEdgeFunction } from './supabaseClient';
import { matchAndAutoComplete, formatActivityType, type GarminActivityRow } from '@/calculations/activity-matcher';
import { render } from '@/ui/renderer';
import { getMutableState, saveState } from '@/state';
import { processPendingCrossTraining } from './activitySync';

/**
 * Fetch recent Strava activities and match them to the current week's plan.
 * Returns the number of activities processed.
 */
export async function syncStravaActivities(): Promise<{ processed: number }> {
  try {
    const s = getMutableState();

    const since = new Date();
    since.setDate(since.getDate() - 28);
    const afterTimestamp = Math.floor(since.getTime() / 1000);

    const rows = await callEdgeFunction<GarminActivityRow[]>(
      'sync-strava-activities',
      {
        after_timestamp: afterTimestamp,
        biological_sex: s.biologicalSex,
      },
    );

    const activityRows = Array.isArray(rows) ? rows : [];

    if (activityRows.length === 0) {
      // Still check for any stuck __pending__ items from a previous sync
      if (!document.getElementById('activity-review-overlay') &&
          !document.getElementById('suggestion-modal')) {
        // _pendingModalActive is in activitySync.ts — processPendingCrossTraining handles the guard
      }
      processPendingCrossTraining();
      return { processed: 0 };
    }

    const result = matchAndAutoComplete(activityRows);

    // Patch hrZones + kmSplits + displayName onto garminActuals for already-matched activities.
    // This runs every sync so stale data (e.g. old "WORKOUT" label) gets corrected when
    // the edge function returns an updated activity_type (e.g. "HIIT" via sport_type).
    let extraPatched = false;
    for (const row of activityRows as (GarminActivityRow & { hrZones?: unknown; kmSplits?: number[]; polyline?: string })[]) {
      // Search across ALL weeks so past-week activities also get updated labels
      for (const wk of s.wks || []) {
        if (!wk.garminActuals || !wk.garminMatched) continue;
        const workoutId = wk.garminMatched[row.garmin_id];
        if (!workoutId || workoutId === '__pending__' || workoutId === 'log-only') continue;
        const actual = wk.garminActuals[workoutId];
        if (!actual) continue;
        // Update hrZones when the row has them and the actual doesn't yet — happens when an
        // activity was first matched during a sync where the stream fetch failed (rate limit)
        // but a later sync succeeded (because zones are now cached in DB, the second sync
        // returns real zones from DB instead of hitting the Strava API again).
        if (row.hrZones && !actual.hrZones) { actual.hrZones = row.hrZones as { z1: number; z2: number; z3: number; z4: number; z5: number }; extraPatched = true; }
        if (row.kmSplits?.length && !actual.kmSplits) { actual.kmSplits = row.kmSplits; extraPatched = true; }
        if (row.polyline && !actual.polyline) { actual.polyline = row.polyline; extraPatched = true; }
        if (!actual.startTime && row.start_time) { actual.startTime = row.start_time; extraPatched = true; }
        // Update displayName if activity type changed (e.g. WORKOUT → HIIT after edge fn redeployment)
        const newDisplayName = formatActivityType(row.activity_type);
        if (actual.displayName && actual.displayName !== newDisplayName &&
            newDisplayName !== 'workout' && newDisplayName !== 'WORKOUT') {
          actual.displayName = newDisplayName; extraPatched = true;
        }
      }
    }
    if (extraPatched) saveState();

    if (result.changed) render();

    // Reset pending modal guard if no modal is open, then process any pending items
    processPendingCrossTraining();

    console.log(`[StravaSync] processed ${activityRows.length} activities, ${result.pending.length} queued for review`);
    return { processed: activityRows.length };
  } catch (err) {
    console.warn('[StravaSync] Failed to sync:', err);
    return { processed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Phase C1 — History fetch
// ---------------------------------------------------------------------------

/** One week's worth of aggregated training data from the history edge function. */
export interface HistorySummaryRow {
  weekStart: string;       // ISO date of Monday e.g. "2026-02-17"
  totalTSS: number;        // Running-equivalent TSS for the week
  runningKm: number;       // km from running activities only
  zoneBase: number;        // Estimated base (Z1+Z2) TSS
  zoneThreshold: number;   // Estimated threshold (Z3) TSS
  zoneIntensity: number;   // Estimated intensity (Z4+Z5) TSS
  sportBreakdown: { sport: string; durationMin: number; tss: number }[];
}

/**
 * Fetch weekly TSS + km history from the DB (via edge function history mode).
 * Stores results on state and computes ctlBaseline + detectedWeeklyKm.
 *
 * Requires Strava connected. Safe to call on app startup or from onboarding.
 */
export async function fetchStravaHistory(weeks = 8): Promise<HistorySummaryRow[]> {
  try {
    const rows = await callEdgeFunction<HistorySummaryRow[]>(
      'sync-strava-activities',
      { mode: 'history', weeks },
    );

    if (!Array.isArray(rows) || rows.length === 0) return [];

    // Persist to state
    const s = getMutableState();
    s.stravaHistoryFetched = true;
    s.historicWeeklyTSS = rows.map((r) => r.totalTSS);
    s.historicWeeklyKm = rows.map((r) => r.runningKm);

    // Compute CTL baseline: 42-day EMA over the history window
    // (same decay as computeACWR: e^(-7/42) ≈ 0.847/week)
    const CTL_DECAY = Math.exp(-7 / 42);
    let ctl = 0;
    for (const tss of s.historicWeeklyTSS) {
      ctl = ctl * CTL_DECAY + tss * (1 - CTL_DECAY);
    }
    s.ctlBaseline = Math.round(ctl);

    // Average weekly running km (last 4 weeks or all available, whichever is fewer)
    const recentKm = s.historicWeeklyKm.slice(-4);
    s.detectedWeeklyKm = recentKm.length > 0
      ? Math.round(recentKm.reduce((a, b) => a + b, 0) / recentKm.length * 10) / 10
      : undefined;

    // Derive athlete tier from CTL baseline (spec §2)
    const ctlForTier = s.ctlBaseline ?? 0;
    s.athleteTier = ctlForTier < 30 ? 'beginner'
      : ctlForTier < 60  ? 'recreational'
      : ctlForTier < 90  ? 'trained'
      : ctlForTier < 120 ? 'performance'
      :                    'high_volume';

    saveState();
    console.log(`[StravaHistory] ${rows.length} weeks loaded — CTL baseline ${s.ctlBaseline}, avg km ${s.detectedWeeklyKm}`);
    return rows;
  } catch (err) {
    console.warn('[StravaHistory] Failed to fetch history:', err);
    return [];
  }
}
