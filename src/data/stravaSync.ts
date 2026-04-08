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
        max_hr_override: s.maxHR ?? undefined,
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
    for (const row of activityRows as (GarminActivityRow & { hrZones?: unknown; kmSplits?: number[]; polyline?: string; hrDrift?: number | null; elevationGainM?: number | null })[]) {
      // Search across ALL weeks so past-week activities also get updated labels
      for (const wk of s.wks || []) {
        if (!wk.garminMatched) continue;
        const workoutId = wk.garminMatched[row.garmin_id];
        if (!workoutId || workoutId === '__pending__' || workoutId === 'log-only') continue;

        // Patch adhoc workouts (unmatched activities accepted by user)
        if (workoutId.startsWith('garmin-')) {
          const adhoc = (wk.adhocWorkouts ?? []).find(w => w.id === workoutId) as any;
          if (adhoc) {
            if (row.polyline && !adhoc.polyline) { adhoc.polyline = row.polyline; extraPatched = true; }
            if (row.kmSplits?.length && !adhoc.kmSplits?.length) { adhoc.kmSplits = row.kmSplits; extraPatched = true; }
            if (row.hrZones && !adhoc.hrZones) { adhoc.hrZones = row.hrZones; extraPatched = true; }
          }
          continue;
        }

        if (!wk.garminActuals) continue;
        const actual = wk.garminActuals[workoutId];
        if (!actual) continue;
        // Update hrZones when the row has them and the actual doesn't yet — happens when an
        // activity was first matched during a sync where the stream fetch failed (rate limit)
        // but a later sync succeeded (because zones are now cached in DB, the second sync
        // returns real zones from DB instead of hitting the Strava API again).
        if (row.hrZones && !actual.hrZones) { actual.hrZones = row.hrZones as { z1: number; z2: number; z3: number; z4: number; z5: number }; extraPatched = true; }
        if (row.kmSplits?.length) {
          // Always prefer DB splits (sourced from Strava splits_metric) over client-computed ones
          const splitsChanged = !actual.kmSplits || JSON.stringify(actual.kmSplits) !== JSON.stringify(row.kmSplits);
          if (splitsChanged) { actual.kmSplits = row.kmSplits; extraPatched = true; }
        }
        if (row.hrDrift != null && actual.hrDrift == null) { actual.hrDrift = row.hrDrift; extraPatched = true; }
        if (row.elevationGainM != null && actual.elevationGainM == null) { actual.elevationGainM = row.elevationGainM; extraPatched = true; }
        if (row.polyline && !actual.polyline) { actual.polyline = row.polyline; extraPatched = true; }
        if (!actual.startTime && row.start_time) { actual.startTime = row.start_time; extraPatched = true; }
        // Heal avgPaceSecKm: prefer DB moving-time pace over elapsed-time computation
        if (row.avg_pace_sec_km != null && actual.avgPaceSecKm !== row.avg_pace_sec_km) {
          actual.avgPaceSecKm = row.avg_pace_sec_km; extraPatched = true;
        }
        // Update activityType if missing (e.g. entry created before field was tracked)
        if (!actual.activityType && row.activity_type) {
          actual.activityType = row.activity_type; extraPatched = true;
        }
        // Update displayName if activity type changed (e.g. WORKOUT → HIIT after edge fn redeployment)
        const newDisplayName = formatActivityType(row.activity_type);
        if (actual.displayName && actual.displayName !== newDisplayName &&
            newDisplayName !== 'workout' && newDisplayName !== 'WORKOUT') {
          actual.displayName = newDisplayName; extraPatched = true;
        }
      }
    }
    if (extraPatched) saveState();

    // Derive maxHR from Strava activities if not set (Apple Watch users don't get it
    // from physiology sync). Uses 95th percentile of max_hr values from recent activities,
    // filtering wrist-sensor spikes. Matches the server-side computation in the edge function.
    if (!s.maxHR) {
      const maxHrs = activityRows
        .map(r => r.max_hr)
        .filter((hr): hr is number => hr != null && hr > 100 && hr < 230);
      if (maxHrs.length >= 3) {
        maxHrs.sort((a, b) => a - b);
        const idx = Math.floor(maxHrs.length * 0.95);
        const derived = maxHrs[Math.min(idx, maxHrs.length - 1)];
        s.maxHR = derived;
        saveState();
        console.log(`[StravaSync] Derived maxHR=${derived} from ${maxHrs.length} activities (95th pct)`);
      }
    }

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

    // Signal B baseline: median of completed weekly rawTSS (not average).
    // Median is resistant to injury/rest weeks that drag the average down and would
    // cause phantom excess alerts when the user returns to normal training.
    const completedRawTSS = completedRows.map((r) => r.rawTSS ?? r.totalTSS).filter(v => v > 0);
    if (completedRawTSS.length > 0) {
      const sorted = [...completedRawTSS].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      s.signalBBaseline = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    } else {
      s.signalBBaseline = undefined;
    }

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
    // Weekly-scale thresholds (internal CTL uses weekly EMA → ÷7 = TrainingPeaks daily equivalent).
    // These weekly values correspond to TP CTL tiers: beginner<20, recreational<40, trained<65,
    // performance<90, elite≥90 — multiplied by 7 to match our weekly accumulation.
    s.athleteTier = ctlForTier < 140 ? 'beginner'
      : ctlForTier < 280 ? 'recreational'
      : ctlForTier < 455 ? 'trained'
      : ctlForTier < 630 ? 'performance'
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

export function classifyByName(name: string): 'easy' | 'tempo' | 'interval' | null {
  const lower = name.toLowerCase();
  for (const { keywords, zone } of LABEL_ZONES) {
    if (keywords.some((k) => lower.includes(k))) return zone;
  }
  return null;
}

interface CalibrateRow { name: string; durationMin: number; iTrimp: number; }

/**
 * Map plan workout types and classifyByName zone labels → calibration zone.
 * 'progressive' is intentionally excluded — it spans easy→fast finish, ambiguous.
 * 'test_run', 'rest', 'cross', 'gym', 'strength' → undefined (not running zones).
 */
const TYPE_TO_ZONE: Record<string, 'easy' | 'tempo' | 'interval'> = {
  easy: 'easy',
  long: 'easy',
  tempo: 'tempo',       // also used as a zone label by classifyByName
  threshold: 'tempo',
  marathon_pace: 'tempo',
  vo2: 'interval',
  intervals: 'interval',
  interval: 'interval', // zone label from classifyByName
};

/**
 * TSS/hr guard-rail ceilings per zone.
 * If actual TSS/hr exceeds these, the label is probably wrong (e.g. half marathon
 * matched to an easy run slot). The session is skipped — not used for calibration.
 *
 * Easy ceiling (95) = default tempo threshold. Anything above that is clearly not easy.
 * Tempo ceiling (160) = hard race effort. Anything above that is an all-out sprint.
 * Interval ceiling = sanity bound only (handled by the >200 check below).
 */
const ZONE_GUARD_CEILING: Record<'easy' | 'tempo' | 'interval', number> = {
  easy: 95,
  tempo: 160,
  interval: 200,
};

/**
 * Primary calibration path: read matched actuals directly from state.
 * Uses `plannedType` (set at match time) to classify sessions.
 * Falls back to classifyByName on the workoutId string for actuals without plannedType.
 *
 * Returns { totalCalibrated, byZone } or null if not enough data to update thresholds.
 */
function calibrateFromState(): { totalCalibrated: number; byZone: Record<'easy' | 'tempo' | 'interval', number[]> } {
  const s = getMutableState();
  const byZone: Record<'easy' | 'tempo' | 'interval', number[]> = { easy: [], tempo: [], interval: [] };

  for (const wk of s.wks ?? []) {
    if (!wk.garminActuals) continue;
    for (const [workoutId, actual] of Object.entries(wk.garminActuals)) {
      if (!actual.iTrimp || actual.iTrimp <= 0) continue;
      if (!actual.durationSec || actual.durationSec < 600) continue; // ignore <10 min stubs

      // Determine zone: prefer stored plannedType, fall back to workoutId name classification
      const rawType = actual.plannedType ?? workoutId;
      const zone = TYPE_TO_ZONE[rawType] ?? classifyByName(rawType);
      if (!zone) continue;

      const normTSS = (actual.iTrimp * 100) / 15000;
      const tssPerHour = normTSS / (actual.durationSec / 3600);

      if (tssPerHour < 10 || tssPerHour > 200) continue; // sanity bounds

      // Guard rail: reject if actual effort is clearly above the zone ceiling
      // (e.g. half marathon matched to easy run slot → TSS/hr ~110 > 95 ceiling → skip)
      if (tssPerHour > ZONE_GUARD_CEILING[zone]) {
        console.log(`[iTrimpCalibrate:state] Skipping ${workoutId} (planned ${rawType}): TSS/hr=${tssPerHour.toFixed(0)} > ${ZONE_GUARD_CEILING[zone]} zone ceiling`);
        continue;
      }

      byZone[zone].push(tssPerHour);
    }
  }

  const totalCalibrated = byZone.easy.length + byZone.tempo.length + byZone.interval.length;
  console.log(`[iTrimpCalibrate:state] ${totalCalibrated} matched runs — easy:${byZone.easy.length} tempo:${byZone.tempo.length} interval:${byZone.interval.length}`);
  return { totalCalibrated, byZone };
}

/**
 * Apply calibration data to state.intensityThresholds.
 * Shared by both the state-based and edge-fn paths.
 */
function applyCalibration(
  byZone: Record<'easy' | 'tempo' | 'interval', number[]>,
  totalCalibrated: number,
): void {
  const s = getMutableState();
  const MIN_POINTS = 3;
  const easyVals = byZone.easy;
  const tempoVals = byZone.tempo;

  if (easyVals.length >= MIN_POINTS && tempoVals.length >= MIN_POINTS) {
    const easyUpper  = [...easyVals].sort((a, b) => a - b)[Math.floor(easyVals.length * 0.9)];
    const tempoUpper = [...tempoVals].sort((a, b) => a - b)[Math.floor(tempoVals.length * 0.9)];
    s.intensityThresholds = {
      easy:  Math.round(Math.max(55, Math.min(85, easyUpper))),
      tempo: Math.round(Math.max(75, Math.min(115, tempoUpper))),
      calibratedFrom: totalCalibrated,
    };
  } else {
    s.intensityThresholds = {
      easy:  s.intensityThresholds?.easy  ?? 70,
      tempo: s.intensityThresholds?.tempo ?? 95,
      calibratedFrom: totalCalibrated,
    };
  }
  saveState();
  console.log(`[iTrimpCalibrate] ${totalCalibrated} sessions — easy≤${s.intensityThresholds.easy}, tempo≤${s.intensityThresholds.tempo}`);
}

/**
 * Calibrate personal iTRIMP intensity thresholds.
 *
 * Primary path: reads matched actuals from state (uses plannedType set at match time).
 * Fallback path: fetches individually-labelled Strava activity names from edge fn
 *   (covers historical runs matched before plannedType was introduced).
 *
 * Sets `s.intensityThresholds`. Safe to call after `fetchStravaHistory()`.
 */
export async function calibrateIntensityThresholds(weeks = 12): Promise<void> {
  try {
    // Primary: use matched actuals already in state — no network call needed
    const stateResult = calibrateFromState();
    const MIN_POINTS = 3;
    const hasEnoughStateData =
      stateResult.byZone.easy.length >= MIN_POINTS &&
      stateResult.byZone.tempo.length >= MIN_POINTS;

    if (hasEnoughStateData) {
      applyCalibration(stateResult.byZone, stateResult.totalCalibrated);
      return;
    }

    // Fallback: fetch from edge fn (historical Strava activity names, pre-plannedType)
    const rows = await callEdgeFunction<CalibrateRow[]>(
      'sync-strava-activities',
      { mode: 'calibrate', weeks },
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      // Still apply whatever state data we have (updates calibratedFrom count)
      applyCalibration(stateResult.byZone, stateResult.totalCalibrated);
      return;
    }

    // Merge edge fn rows into byZone (additive — state data already in there)
    const merged = { ...stateResult.byZone };
    for (const row of rows) {
      const zone = classifyByName(row.name);
      if (!zone) continue;
      const normTSS = (row.iTrimp * 100) / 15000;
      const tssPerHour = normTSS / (row.durationMin / 60);
      if (tssPerHour > 10 && tssPerHour < 200) {
        merged[zone].push(tssPerHour);
      }
    }

    const totalCalibrated = merged.easy.length + merged.tempo.length + merged.interval.length;
    applyCalibration(merged, totalCalibrated);
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
      { mode: 'backfill', weeks, biological_sex: s.biologicalSex, max_hr_override: s.maxHR ?? undefined },
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
