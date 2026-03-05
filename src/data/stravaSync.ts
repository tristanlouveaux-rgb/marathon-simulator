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
import { mergeTimingMods } from '@/cross-training/timing-check';

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

    // Recompute timing downgrade mods after each sync
    const sAfter = getMutableState();
    const wkAfter = sAfter.wks?.[sAfter.w - 1];
    if (wkAfter && mergeTimingMods(sAfter, wkAfter)) {
      saveState();
    }

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
  totalTSS: number;        // Signal A — running-equivalent TSS (with runSpec discount)
  rawTSS: number;          // Signal B — raw physiological TSS (no runSpec discount)
  runningKm: number;       // km from running activities only
  zoneBase: number;        // Estimated base (Z1+Z2) TSS
  zoneThreshold: number;   // Estimated threshold (Z3) TSS
  zoneIntensity: number;   // Estimated intensity (Z4+Z5) TSS
  sportBreakdown: { sport: string; durationMin: number; tss: number; rawTSS: number; sessionCount: number }[];
}

/**
 * Fetch weekly TSS + km history from the DB (via edge function history mode).
 * Stores results on state and computes ctlBaseline + detectedWeeklyKm.
 *
 * Requires Strava connected. Safe to call on app startup or from onboarding.
 */
export async function fetchStravaHistory(weeks = 8): Promise<HistorySummaryRow[]> {
  try {
    const raw = await callEdgeFunction<HistorySummaryRow[] | { rows: HistorySummaryRow[]; _debug?: Record<string, unknown> }>(
      'sync-strava-activities',
      { mode: 'history', weeks },
    );

    // Handle envelope format (with debug info) or plain array (legacy)
    let rows: HistorySummaryRow[];
    if (Array.isArray(raw)) {
      rows = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray((raw as { rows: HistorySummaryRow[] }).rows)) {
      const env = raw as { rows: HistorySummaryRow[]; _debug?: Record<string, unknown> };
      rows = env.rows;
      if (env._debug) {
        console.log(`[StravaHistory] DB debug: rowCount=${env._debug.rowCount}, historyStart=${env._debug.historyStart}, weeksBack=${env._debug.weeksBack}, user=${env._debug.userId}`);
      }
    } else {
      rows = [];
    }

    if (rows.length === 0) return [];

    // Persist to state — exclude current (partial) week from chart arrays.
    // The edge function includes today's in-progress week in its response.
    // Storing it would shift all historic entries by one position in the chart,
    // making Fix 4 in getChartData backfill the wrong plan week.
    // The current week is always handled live by computeWeekRawTSS.
    const s = getMutableState();
    s.stravaHistoryFetched = true;
    const thisMondayISO = (() => {
      const d = new Date();
      const dayOfWeek = d.getUTCDay();
      const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      d.setUTCDate(d.getUTCDate() + daysToMonday);
      return d.toISOString().split('T')[0];
    })();
    const completedRows = rows.filter((r) => r.weekStart < thisMondayISO);
    s.historicWeeklyTSS = completedRows.map((r) => r.totalTSS);
    s.historicWeeklyRawTSS = completedRows.map((r) => r.rawTSS ?? r.totalTSS); // fallback: use Signal A if rawTSS missing (old edge fn)
    s.historicWeeklyKm = completedRows.map((r) => r.runningKm);
    s.historicWeeklyZones = completedRows.map((r) => ({ base: r.zoneBase, threshold: r.zoneThreshold, intensity: r.zoneIntensity }));

    // Signal A CTL baseline: 42-day EMA of run-equivalent TSS (completed weeks only)
    const CTL_DECAY = Math.exp(-7 / 42);
    let ctl = 0;
    for (const tss of s.historicWeeklyTSS) {
      ctl = ctl * CTL_DECAY + tss * (1 - CTL_DECAY);
    }
    s.ctlBaseline = Math.round(ctl);

    // Signal B baseline: simple average of completed weeks
    const completedRawTSS = completedRows.map((r) => r.rawTSS ?? r.totalTSS);
    s.signalBBaseline = completedRawTSS.length > 0
      ? Math.round(completedRawTSS.reduce((a, b) => a + b, 0) / completedRawTSS.length)
      : undefined;

    // Per-sport session baselines (Phase 2 calibration data — not yet used by reduction logic)
    // Aggregate all sport breakdown data across weeks, compute avg session rawTSS + freq/week
    const sportAgg: Record<string, { totalRawTSS: number; totalSessions: number; weekCount: number }> = {};
    for (const row of rows) {
      for (const entry of row.sportBreakdown) {
        if (entry.sport === 'running') continue; // running handled via Signal A separately
        if (!sportAgg[entry.sport]) sportAgg[entry.sport] = { totalRawTSS: 0, totalSessions: 0, weekCount: 0 };
        sportAgg[entry.sport].totalRawTSS += entry.rawTSS ?? entry.tss;
        sportAgg[entry.sport].totalSessions += entry.sessionCount ?? 1;
        sportAgg[entry.sport].weekCount += 1;
      }
    }
    s.sportBaselineByType = {};
    for (const [sport, agg] of Object.entries(sportAgg)) {
      if (agg.totalSessions === 0) continue;
      s.sportBaselineByType[sport] = {
        avgSessionRawTSS: Math.round(agg.totalRawTSS / agg.totalSessions),
        sessionsPerWeek: Math.round((agg.totalSessions / Math.max(rows.length, 1)) * 10) / 10,
      };
    }

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
    console.log(`[StravaHistory] ${rows.length} weeks loaded — CTL baseline ${s.ctlBaseline} (Signal A), Signal B baseline ${s.signalBBaseline}, avg km ${s.detectedWeeklyKm}`);
    for (const r of rows) {
      const sports = r.sportBreakdown.map((b) => `${b.sport}=${b.tss}TSS(${b.durationMin}min)`).join(', ');
      console.log(`[StravaHistory]  ${r.weekStart}: totalTSS=${r.totalTSS} runKm=${r.runningKm} | ${sports || '(no activities)'}`);
    }

    // Kick off iTRIMP calibration in parallel — results stored on state independently
    calibrateIntensityThresholds().catch(() => {/* silent */});

    return rows;
  } catch (err) {
    console.warn('[StravaHistory] Failed to fetch history:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase B v3 — iTRIMP calibration from labelled Strava runs
// ---------------------------------------------------------------------------

/**
 * Recognised Strava workout name keywords → intensity zone.
 * Matching is case-insensitive substring. First match wins.
 */
const LABEL_ZONES: { keywords: string[]; zone: 'easy' | 'tempo' | 'interval' }[] = [
  { keywords: ['interval', 'vo2', 'speed', 'track', 'repeat', 'fartlek'], zone: 'interval' },
  { keywords: ['tempo', 'threshold', 'lactate', 'lt', 'race pace', 'marathon pace', 'mp run'], zone: 'tempo' },
  { keywords: ['easy', 'recovery', 'shake', 'jog', 'long', 'slow', 'base', 'aerobic'], zone: 'easy' },
];

function classifyByName(name: string): 'easy' | 'tempo' | 'interval' | null {
  const lower = name.toLowerCase();
  for (const { keywords, zone } of LABEL_ZONES) {
    if (keywords.some((k) => lower.includes(k))) return zone;
  }
  return null;
}

interface CalibrateRow { name: string; durationMin: number; iTrimp: number; }

/**
 * Fetch individually-labelled running activities from Strava history and use
 * them to calibrate personal iTRIMP intensity thresholds.
 *
 * Sets `s.intensityThresholds` on state. Safe to call after `fetchStravaHistory()`.
 * Requires at least 3 data points per zone to update thresholds (falls back to
 * defaults of easy≤70, tempo≤95 TSS/hr otherwise).
 */
export async function calibrateIntensityThresholds(weeks = 12): Promise<void> {
  try {
    const rows = await callEdgeFunction<CalibrateRow[]>(
      'sync-strava-activities',
      { mode: 'calibrate', weeks },
    );

    if (!Array.isArray(rows) || rows.length === 0) return;

    // Normalise iTRIMP → TSS/hr using spec formula: normalisedTSS = (iTrimp * 100) / 15000
    // TSS/hr = normalisedTSS / (durationMin / 60)
    const byZone: Record<'easy' | 'tempo' | 'interval', number[]> = {
      easy: [], tempo: [], interval: [],
    };

    for (const row of rows) {
      const zone = classifyByName(row.name);
      if (!zone) continue;
      const normTSS = (row.iTrimp * 100) / 15000;
      const tssPerHour = normTSS / (row.durationMin / 60);
      if (tssPerHour > 10 && tssPerHour < 200) { // sanity bounds
        byZone[zone].push(tssPerHour);
      }
    }

    const s = getMutableState();
    const MIN_POINTS = 3;

    const easyVals = byZone.easy;
    const tempoVals = byZone.tempo;
    const totalCalibrated = easyVals.length + tempoVals.length + byZone.interval.length;

    if (easyVals.length >= MIN_POINTS && tempoVals.length >= MIN_POINTS) {
      // Upper bound for easy = 90th percentile of easy TSS/hr (excludes outlier hard easy days)
      const easyUpper = easyVals.sort((a, b) => a - b)[Math.floor(easyVals.length * 0.9)];
      // Upper bound for tempo = 90th percentile of tempo TSS/hr
      const tempoUpper = tempoVals.sort((a, b) => a - b)[Math.floor(tempoVals.length * 0.9)];

      s.intensityThresholds = {
        easy: Math.round(Math.max(55, Math.min(85, easyUpper))),   // clamp 55–85
        tempo: Math.round(Math.max(75, Math.min(115, tempoUpper))), // clamp 75–115
        calibratedFrom: totalCalibrated,
      };
    } else {
      // Not enough data — keep defaults but record how many we have
      s.intensityThresholds = {
        easy: s.intensityThresholds?.easy ?? 70,
        tempo: s.intensityThresholds?.tempo ?? 95,
        calibratedFrom: totalCalibrated,
      };
    }

    saveState();
    console.log(`[iTrimpCalibrate] ${totalCalibrated} labelled runs — easy≤${s.intensityThresholds.easy}, tempo≤${s.intensityThresholds.tempo}`);
  } catch (err) {
    console.warn('[iTrimpCalibrate] Failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Strava history backfill
// ---------------------------------------------------------------------------

export interface BackfillResult {
  processed: number;
  withHRStream: number;
  withAvgHR: number;
  hasHRMonitor: boolean;
  stravaWeeks?: Record<string, number>;
  totalStravaActivities?: number;
  _debug?: {
    cachedWithZones: number;
    cachedBasic: number;
    cachedWithITrimp: number;
    needFullStream: number;
    needAvgHR: number;
    upsertErrors: string[];
  };
}

/**
 * Fetch N weeks of Strava activity history, compute HR-based iTRIMP for each,
 * and store in garmin_activities. Full HR stream for the most-recent ≤99
 * uncached activities; avg_heartrate estimate for the rest.
 *
 * After backfill completes, runs fetchStravaHistory() to refresh state.
 * Safe to call multiple times — already-cached activities are skipped.
 */
export async function backfillStravaHistory(weeks = 16): Promise<BackfillResult> {
  console.log(`[StravaBackfill] Starting ${weeks}-week backfill…`);
  try {
    const s = getMutableState();
    const result = await callEdgeFunction<BackfillResult>(
      'sync-strava-activities',
      { mode: 'backfill', weeks, biological_sex: s.biologicalSex },
    );
    console.log(`[StravaBackfill] Done — ${result?.processed ?? 0} new activities (${result?.withHRStream ?? 0} HR stream + ${result?.withAvgHR ?? 0} avg HR), hasHRMonitor=${result?.hasHRMonitor}, totalStrava=${result?.totalStravaActivities ?? '?'}`);
    if (result?._debug) {
      const d = result._debug;
      console.log(`[StravaBackfill] Cache: cachedWithZones=${d.cachedWithZones}, cachedBasic=${d.cachedBasic}, cachedWithITrimp=${d.cachedWithITrimp} | Queued: needFullStream=${d.needFullStream}, needAvgHR=${d.needAvgHR}`);
      if (d.upsertErrors.length > 0) {
        console.error(`[StravaBackfill] Upsert errors:`, d.upsertErrors);
      }
    }
    // Log per-week Strava breakdown (server-side logs aren't visible in browser)
    if (result?.stravaWeeks) {
      const entries = Object.entries(result.stravaWeeks).sort(([a], [b]) => a.localeCompare(b));
      console.log(`[StravaBackfill] Strava returned ${entries.length} weeks:`);
      for (const [wk, count] of entries) {
        console.log(`[StravaBackfill]   ${wk}: ${count} activities`);
      }
    }
    // Re-run history aggregation so state reflects the newly stored activities.
    // Fetch the full window (weeks) and store in both historicWeeklyTSS and extendedHistoryTSS
    // so the stats "16w" button shows data immediately without a second round-trip.
    const historyRows = await fetchStravaHistory(weeks);
    console.log(`[StravaBackfill] History now has ${historyRows.length} weeks of data`);

    // Also populate extendedHistory so the 16w tab in stats works immediately.
    // Filter out current partial week — same as fetchStravaHistory does.
    if (weeks >= 16 && historyRows.length > 0) {
      const s = getMutableState();
      const thisMondayISO = (() => {
        const d = new Date();
        const dayOfWeek = d.getUTCDay();
        const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        d.setUTCDate(d.getUTCDate() + daysToMonday);
        return d.toISOString().split('T')[0];
      })();
      const completedHistRows = historyRows.filter((r) => r.weekStart < thisMondayISO);
      s.extendedHistoryWeeks = weeks;
      s.extendedHistoryTSS = completedHistRows.map((r) => r.totalTSS);
      s.extendedHistoryKm = completedHistRows.map((r) => r.runningKm);
      s.extendedHistoryZones = completedHistRows.map((r) => ({ base: r.zoneBase, threshold: r.zoneThreshold, intensity: r.zoneIntensity }));
      // historicWeeklyTSS stays as the last 8 completed entries for the default "8w" view
      s.historicWeeklyTSS = completedHistRows.slice(-8).map((r) => r.totalTSS);
      s.historicWeeklyKm = completedHistRows.slice(-8).map((r) => r.runningKm);
      s.historicWeeklyZones = completedHistRows.slice(-8).map((r) => ({ base: r.zoneBase, threshold: r.zoneThreshold, intensity: r.zoneIntensity }));
      saveState();
    }

    return result ?? { processed: 0, withHRStream: 0, withAvgHR: 0, hasHRMonitor: false };
  } catch (err) {
    console.error('[StravaBackfill] Failed:', err);
    return { processed: 0, withHRStream: 0, withAvgHR: 0, hasHRMonitor: false };
  }
}

// ---------------------------------------------------------------------------
// Phase D — Extended history fetch (16w / all-time)
// ---------------------------------------------------------------------------

/**
 * Fetch a longer history window on demand (triggered by time range selector).
 * Results stored separately from the default 8-week cache so startup stays fast.
 */
export async function fetchExtendedHistory(weeks: 16 | 52): Promise<void> {
  try {
    const rows = await callEdgeFunction<HistorySummaryRow[]>(
      'sync-strava-activities',
      { mode: 'history', weeks },
    );
    if (!Array.isArray(rows) || rows.length === 0) return;
    const s = getMutableState();
    s.extendedHistoryWeeks = weeks;
    s.extendedHistoryTSS = rows.map((r) => r.totalTSS);
    s.extendedHistoryKm = rows.map((r) => r.runningKm);
    s.extendedHistoryZones = rows.map((r) => ({ base: r.zoneBase, threshold: r.zoneThreshold, intensity: r.zoneIntensity }));
    saveState();
    console.log(`[StravaHistory] Extended ${weeks}w loaded — ${rows.length} weeks`);
  } catch (err) {
    console.warn('[StravaHistory] Extended fetch failed:', err);
  }
}
