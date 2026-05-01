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

import { callEdgeFunction, supabase } from './supabaseClient';
import { matchAndAutoComplete, formatActivityType, type GarminActivityRow } from '@/calculations/activity-matcher';
import { render } from '@/ui/renderer';
import { getMutableState, saveState } from '@/state';
import { processPendingCrossTraining, resetPendingModalGuard } from './activitySync';
import { mergeTimingMods } from '@/cross-training/timing-check';

/**
 * Derive athlete tier from weekly-scale CTL baseline plus a performance floor.
 *
 * CTL alone misclassifies athletes whose chronic running load is modest but
 * whose race performance (VDOT, FTP) puts them well above their CTL bucket —
 * e.g. a 3:12 marathoner with 261 W FTP would otherwise read "recreational"
 * because their *running* CTL is moderate. The floor lifts the tier to match
 * demonstrable engine size, never below the CTL-derived tier.
 *
 * Thresholds (CTL): TrainingPeaks daily tiers (20/40/65/90) ×7 for our weekly EMA.
 *
 * Performance floors (rough, not weight-normalised — we don't store body
 * weight; FTP/kg would be cleaner but we use absolute watts as a proxy):
 *  - VDOT ≥ 60 OR FTP ≥ 320 W → at least 'performance'
 *  - VDOT ≥ 50 OR FTP ≥ 250 W → at least 'trained'
 */
export type AthleteTier = 'beginner' | 'recreational' | 'trained' | 'performance' | 'high_volume';

const TIER_RANK: AthleteTier[] = ['beginner', 'recreational', 'trained', 'performance', 'high_volume'];

export interface AthleteTierInputs {
  vdot?: number | null;
  ftpWatts?: number | null;
}

export function deriveAthleteTier(ctlBaseline: number, perf: AthleteTierInputs = {}): AthleteTier {
  const fromCtl: AthleteTier = ctlBaseline < 140 ? 'beginner'
    : ctlBaseline < 280 ? 'recreational'
    : ctlBaseline < 455 ? 'trained'
    : ctlBaseline < 630 ? 'performance'
    :                     'high_volume';

  let floor: AthleteTier = 'beginner';
  const vdot = perf.vdot ?? 0;
  const ftp = perf.ftpWatts ?? 0;
  if (vdot >= 60 || ftp >= 320) floor = 'performance';
  else if (vdot >= 50 || ftp >= 250) floor = 'trained';

  return TIER_RANK[Math.max(TIER_RANK.indexOf(fromCtl), TIER_RANK.indexOf(floor))];
}

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
    console.log(`[StravaSync] matchAndAutoComplete: changed=${result.changed}, pending=${result.pending.length}, pending garminIds=[${result.pending.map(p => p.garminId).join(', ')}]`);

    // Patch hrZones + kmSplits + displayName onto garminActuals for already-matched activities.
    // This runs every sync so stale data (e.g. old "WORKOUT" label) gets corrected when
    // the edge function returns an updated activity_type (e.g. "HIIT" via sport_type).
    let extraPatched = false;
    for (const row of activityRows as (GarminActivityRow & { hrZones?: unknown; kmSplits?: number[]; polyline?: string; hrDrift?: number | null; ambientTempC?: number | null; elevationGainM?: number | null; averageWatts?: number | null; normalizedPowerW?: number | null; maxWatts?: number | null; deviceWatts?: boolean | null; kilojoules?: number | null; powerCurve?: { p600: number | null; p1200: number | null; p1800: number | null; p3600: number | null } | null })[]) {
      // Search across ALL weeks so past-week activities also get updated labels
      for (const wk of s.wks || []) {
        if (!wk.garminMatched) continue;
        const workoutId = wk.garminMatched[row.garmin_id];
        if (!workoutId || workoutId === '__pending__' || workoutId === 'log-only') continue;

        // Patch adhoc workouts (unmatched activities accepted by user). Adhoc
        // workouts also have a garminActuals entry keyed by adhocId, so fall
        // through to the actual-patching block below after updating the adhoc
        // record itself — otherwise power fields fetched on a later sync never
        // reach the detail view, which reads from garminActuals.
        if (workoutId.startsWith('garmin-')) {
          const adhoc = (wk.adhocWorkouts ?? []).find(w => w.id === workoutId) as any;
          if (adhoc) {
            if (row.polyline && !adhoc.polyline) { adhoc.polyline = row.polyline; extraPatched = true; }
            if (row.kmSplits?.length && !adhoc.kmSplits?.length) { adhoc.kmSplits = row.kmSplits; extraPatched = true; }
            if (row.hrZones && !adhoc.hrZones) { adhoc.hrZones = row.hrZones; extraPatched = true; }
          }
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
        if (row.ambientTempC != null && actual.ambientTempC == null) { actual.ambientTempC = row.ambientTempC; extraPatched = true; }
        if (row.elevationGainM != null && actual.elevationGainM == null) { actual.elevationGainM = row.elevationGainM; extraPatched = true; }
        if (row.calories != null && actual.calories == null) { actual.calories = row.calories; extraPatched = true; }
        if (row.polyline && !actual.polyline) { actual.polyline = row.polyline; extraPatched = true; }
        // Power fields — DB is canonical (refreshed by every Strava sync), so overwrite
        // whenever it has a non-null value that differs. Filling-nulls-only would leave
        // stale numbers stuck (e.g. averageWatts captured before the power-detail backfill).
        if (row.averageWatts != null && actual.averageWatts !== row.averageWatts) { actual.averageWatts = row.averageWatts; extraPatched = true; }
        if (row.normalizedPowerW != null && actual.normalizedPowerW !== row.normalizedPowerW) { actual.normalizedPowerW = row.normalizedPowerW; extraPatched = true; }
        if (row.maxWatts != null && actual.maxWatts !== row.maxWatts) { actual.maxWatts = row.maxWatts; extraPatched = true; }
        if (row.deviceWatts != null && actual.deviceWatts !== row.deviceWatts) { actual.deviceWatts = row.deviceWatts; extraPatched = true; }
        if (row.kilojoules != null && actual.kilojoules !== row.kilojoules) { actual.kilojoules = row.kilojoules; extraPatched = true; }
        if (row.powerCurve != null) {
          const cur = actual.powerCurve;
          const same = cur && cur.p600 === row.powerCurve.p600 && cur.p1200 === row.powerCurve.p1200
            && cur.p1800 === row.powerCurve.p1800 && cur.p3600 === row.powerCurve.p3600;
          if (!same) { actual.powerCurve = row.powerCurve; extraPatched = true; }
        }
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
    // Third pass: "Strava always wins" — upgrade any Garmin-sourced actuals that have a
    // matching Strava row in this batch, identified by start_time ±10 min. This is the
    // defensive fallback for cases where the upgrade loop in matchAndAutoComplete was
    // blocked by a stale garminMatched mapping (e.g. "strava-X" → "__pending__" from a
    // previous sync with the garminPending-overwrite bug). Idempotent — already-upgraded
    // actuals (garminId starts with 'strava-') are skipped.
    const stravaRowByTime = new Map<number, GarminActivityRow>();
    for (const row of activityRows as GarminActivityRow[]) {
      if (row.garmin_id.startsWith('strava-') && row.start_time) {
        stravaRowByTime.set(new Date(row.start_time).getTime(), row);
      }
    }
    if (stravaRowByTime.size > 0) {
      for (const wk of s.wks || []) {
        if (!wk.garminActuals || !wk.garminMatched) continue;
        for (const [wid, actual] of Object.entries(wk.garminActuals)) {
          if (actual.garminId.startsWith('strava-')) continue;
          if (!actual.startTime) continue;
          const actualMs = new Date(actual.startTime).getTime();
          let matchRow: GarminActivityRow | undefined;
          for (const [rowMs, r] of stravaRowByTime) {
            if (Math.abs(actualMs - rowMs) < 10 * 60 * 1000) { matchRow = r; break; }
          }
          if (!matchRow) continue;
          const oldGarminId = actual.garminId;
          actual.garminId = matchRow.garmin_id;
          actual.avgPaceSecKm = matchRow.avg_pace_sec_km ?? actual.avgPaceSecKm;
          actual.avgHR = matchRow.avg_hr ?? actual.avgHR;
          actual.maxHR = matchRow.max_hr ?? actual.maxHR;
          actual.calories = matchRow.calories ?? actual.calories;
          if (matchRow.hrZones) actual.hrZones = matchRow.hrZones as { z1: number; z2: number; z3: number; z4: number; z5: number };
          if (matchRow.polyline) actual.polyline = matchRow.polyline;
          if (matchRow.kmSplits?.length) actual.kmSplits = matchRow.kmSplits;
          if (matchRow.elevationGainM != null) actual.elevationGainM = matchRow.elevationGainM;
          if (matchRow.hrDrift != null) actual.hrDrift = matchRow.hrDrift;
          // Strava is canonical for power — overwrite even if Garmin row had numbers
          if (matchRow.averageWatts != null) actual.averageWatts = matchRow.averageWatts;
          if (matchRow.normalizedPowerW != null) actual.normalizedPowerW = matchRow.normalizedPowerW;
          if (matchRow.maxWatts != null) actual.maxWatts = matchRow.maxWatts;
          if (matchRow.deviceWatts != null) actual.deviceWatts = matchRow.deviceWatts;
          if (matchRow.kilojoules != null) actual.kilojoules = matchRow.kilojoules;
          if (matchRow.powerCurve != null) actual.powerCurve = matchRow.powerCurve;
          // Update garminMatched so the re-enrich loop can find it on future syncs.
          // This also overwrites any stale '__pending__' left by a prior corrupted sync.
          wk.garminMatched[matchRow.garmin_id] = wid;
          extraPatched = true;
          console.log(`[StravaWins] Upgraded ${oldGarminId} → ${matchRow.garmin_id} for slot ${wid}`);
        }
      }
    }

    // Second pass: patch calories by start_time for Garmin-webhook-matched activities.
    // The garmin_id loop above only matches strava-{id} rows, but activities matched via
    // Garmin webhook have a numeric garmin_id. Match by start_time to bridge the gap.
    const calByTime = new Map<string, number>();
    for (const row of activityRows as GarminActivityRow[]) {
      if (row.calories != null && row.calories > 0) {
        calByTime.set(row.start_time, row.calories);
      }
    }
    for (const wk of s.wks || []) {
      // Patch garminActuals
      if (wk.garminActuals) {
        for (const [wid, actual] of Object.entries(wk.garminActuals)) {
          if (actual.calories != null && actual.calories > 0) continue;
          if (!actual.startTime) continue;
          const cal = calByTime.get(actual.startTime);
          if (cal != null) { actual.calories = cal; extraPatched = true; }
        }
      }
      // Patch adhocWorkouts (garminCalories field used by detail view)
      for (const w of (wk.adhocWorkouts ?? []) as any[]) {
        if (w.garminCalories != null && w.garminCalories > 0) continue;
        const ts = w.garminTimestamp ?? w.startTime;
        if (!ts) continue;
        const cal = calByTime.get(ts);
        if (cal != null) { w.garminCalories = cal; extraPatched = true; }
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

    // Log current week pending state for debugging
    const _wkDbg = getMutableState().wks?.[getMutableState().w - 1];
    const _pendingDbg = (_wkDbg?.garminPending ?? []).filter((p: any) => _wkDbg?.garminMatched?.[p.garminId] === '__pending__');
    console.log(`[StravaSync] Before processPending: ${_pendingDbg.length} pending items, garminActuals keys=[${Object.keys(_wkDbg?.garminActuals ?? {}).join(', ')}], adhocWorkouts=${(_wkDbg?.adhocWorkouts ?? []).length}`);

    // Reset pending modal guard if no modal is open (mirrors activitySync.ts),
    // then process any pending items. Without this reset, a cancelled review in a
    // previous session leaves _pendingModalActive stuck at true, silently blocking
    // all future pending processing.
    if (!document.getElementById('activity-review-overlay') &&
        !document.getElementById('suggestion-modal')) {
      // Access the module-level guard via re-export
      resetPendingModalGuard();
    }
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
    s.historicLastRefreshedAt = new Date().toISOString();
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

    s.athleteTier = deriveAthleteTier(s.ctlBaseline ?? 0, {
      vdot: s.v,
      ftpWatts: s.onboarding?.triBike?.ftp,
    });

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
  bestEffortsHealed?: number;
  bestEffortsCandidates?: number;
  bestEffortsPool?: number;
  /** Per-activity run summary — feeds `computePredictionInputs` (Tanda) and
   *  `computeHRCalibratedVdot` (Swain HR regression) after onboarding. */
  runs?: Array<{
    startTime: string;
    distKm: number;
    durSec: number;
    activityType: string;
    activityName?: string;
    avgHR?: number | null;
  }>;
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
    if (result?.bestEffortsPool != null || result?.bestEffortsHealed != null) {
      console.log(`[StravaBackfill] best_efforts: healed ${result?.bestEffortsHealed ?? 0}/${result?.bestEffortsCandidates ?? 0} (pool of ${result?.bestEffortsPool ?? '?'} runs missing best_efforts)`);
    }
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
      // historicWeekly* stays as the last 8 completed entries for the default "8w" view.
      // All four arrays must be kept in lockstep — consumers index them by the same week.
      const last8 = completedHistRows.slice(-8);
      s.historicWeeklyTSS = last8.map((r) => r.totalTSS);
      s.historicWeeklyRawTSS = last8.map((r) => r.rawTSS ?? r.totalTSS);
      s.historicWeeklyKm = last8.map((r) => r.runningKm);
      s.historicWeeklyZones = last8.map((r) => ({ base: r.zoneBase, threshold: r.zoneThreshold, intensity: r.zoneIntensity }));
      saveState();
    }

    // Stash per-run summary so refreshBlendedFitness can seed Tanda immediately.
    // garminActuals won't be populated until the first standalone sync fills in
    // matched rows — this gives us a full 16-week pool for K and P on day one.
    if (result?.runs && result.runs.length > 0) {
      const s = getMutableState();
      s.onboardingRunHistory = result.runs;
      // Refresh the blended prediction now that per-run inputs are available.
      try {
        const { refreshBlendedFitness } = await import('@/calculations/blended-fitness');
        const ok = refreshBlendedFitness(s);
        if (ok) console.log(`[StravaBackfill] Blended fitness refreshed: vdot=${s.blendedEffectiveVdot?.toFixed(1)}, raceSec=${s.blendedRaceTimeSec?.toFixed(0)}`);
      } catch (e) {
        console.warn('[StravaBackfill] refreshBlendedFitness failed:', e);
      }
      saveState();
    }

    return result ?? { processed: 0, withHRStream: 0, withAvgHR: 0, hasHRMonitor: false };
  } catch (err) {
    console.error('[StravaBackfill] Failed:', err);
    return { processed: 0, withHRStream: 0, withAvgHR: 0, hasHRMonitor: false };
  }
}

// ---------------------------------------------------------------------------
// Recovery: rebuild `previousPlanWks` from raw activity rows on the server
// ---------------------------------------------------------------------------

/**
 * Fetch the user's earliest Strava activity timestamp. Stored on
 * `state.firstStravaActivityISO` to derive years-of-training for the
 * triathlon prediction's experience-level bucket. Idempotent — caller
 * should skip if `state.firstStravaActivityISO` is already set.
 *
 * Returns ISO timestamp or null if no activity / no auth / DB error.
 */
export async function fetchEarliestActivityDate(): Promise<string | null> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return null;
    const { data, error } = await supabase
      .from('garmin_activities')
      .select('start_time')
      .eq('user_id', userId)
      .order('start_time', { ascending: true })
      .limit(1);
    if (error) {
      console.warn('[FetchEarliest] DB query failed:', error.message);
      return null;
    }
    const row = (data ?? [])[0] as { start_time?: string | null } | undefined;
    return row?.start_time ?? null;
  } catch (e: any) {
    console.warn('[FetchEarliest] Unexpected error:', e?.message ?? e);
    return null;
  }
}

/**
 * Recover daily activity history that was lost when a previous plan reset
 * wiped `s.wks` without archiving. Pulls raw activity rows from the standalone
 * `sync-strava-activities` endpoint over a wide window (default 90 days),
 * groups them into 7-day buckets keyed off the oldest activity's Monday, and
 * synthesises a `previousPlanWks` archive entry the same way `_resolveWeekForDate`
 * expects. After this runs, the rolling-load 28-day chart, ACWR, sleep debt,
 * and coach signals all pick up the historical activities.
 *
 * Idempotent: appends a new archive entry; existing archive entries (if any)
 * are preserved up to the 2-entry cap.
 *
 * Returns number of activity rows ingested into the synthetic archive.
 */
export async function restoreHistoryFromServer(daysBack = 90): Promise<{ activitiesRecovered: number; weeksReconstructed: number }> {
  try {
    const s = getMutableState();
    // Query `garmin_activities` directly — the standalone `sync-strava-activities`
    // endpoint only returns activities not yet processed (sync-state filter), so
    // historical rows that the user already synced before a plan reset are
    // invisible to it. We need raw DB rows.
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) {
      console.warn('[RestoreHistory] No authenticated user.');
      return { activitiesRecovered: 0, weeksReconstructed: 0 };
    }

    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    const sinceISO = since.toISOString();

    const { data, error } = await supabase
      .from('garmin_activities')
      .select(
        'garmin_id, activity_type, start_time, duration_sec, distance_m, avg_pace_sec_km, avg_hr, max_hr, calories, itrimp, hr_zones, km_splits, polyline, activity_name, elevation_gain_m, hr_drift, ambient_temp_c, average_watts, normalized_power, max_watts, device_watts, kilojoules',
      )
      .eq('user_id', userId)
      .gte('start_time', sinceISO)
      .order('start_time', { ascending: true });

    if (error) {
      console.warn('[RestoreHistory] DB query failed:', error.message);
      return { activitiesRecovered: 0, weeksReconstructed: 0 };
    }
    const activityRows = (data ?? []) as any[];
    if (activityRows.length === 0) {
      console.log(`[RestoreHistory] DB returned 0 rows since ${sinceISO} — nothing to recover.`);
      return { activitiesRecovered: 0, weeksReconstructed: 0 };
    }

    const firstStart: string = activityRows[0].start_time;
    if (!firstStart) {
      console.warn('[RestoreHistory] First row missing start_time, aborting.');
      return { activitiesRecovered: 0, weeksReconstructed: 0 };
    }

    // Anchor week 1 to the Monday on or before the first activity.
    const firstDate = new Date(firstStart.split('T')[0] + 'T12:00:00');
    const dayOfWeek = (firstDate.getDay() + 6) % 7; // 0 = Mon
    firstDate.setDate(firstDate.getDate() - dayOfWeek);
    const archivePlanStartISO = firstDate.toISOString().split('T')[0];
    const archiveStartMs = firstDate.getTime();

    // Build week buckets by date offset. DB columns are snake_case + distance in
    // metres; map to the camelCase / km shape the views expect.
    const weekMap = new Map<number, any>();
    for (const r of activityRows) {
      if (!r.start_time) continue;
      const rowMs = new Date(r.start_time).getTime();
      const weekIdx = Math.floor((rowMs - archiveStartMs) / (7 * 86400000));
      if (weekIdx < 0) continue;
      let wk = weekMap.get(weekIdx);
      if (!wk) {
        wk = {
          w: weekIdx + 1,
          ph: 'base',
          rated: {},
          skip: [],
          cross: [],
          wkGain: 0,
          workoutMods: [],
          adjustments: [],
          unspentLoad: 0,
          extraRunLoad: 0,
          garminActuals: {} as Record<string, any>,
          adhocWorkouts: [] as any[],
          garminMatched: {} as Record<string, string>,
        };
        weekMap.set(weekIdx, wk);
      }
      // Archive entries omit only `polyline` (multi-KB GPS string) — 90% of
      // the per-row payload, dropping it lets the cap go from 2 to 12 plans
      // without busting localStorage. kmSplits and hrZones stay so the
      // activity-detail popup still renders pace/zone breakdowns from the
      // archive.
      wk.garminActuals[r.garmin_id] = {
        garminId: r.garmin_id,
        startTime: r.start_time,
        durationSec: r.duration_sec ?? 0,
        distanceKm: r.distance_m != null ? r.distance_m / 1000 : 0,
        avgPaceSecKm: r.avg_pace_sec_km ?? null,
        avgHR: r.avg_hr ?? null,
        maxHR: r.max_hr ?? null,
        calories: r.calories ?? null,
        iTrimp: r.itrimp ?? null,
        hrZones: r.hr_zones ?? null,
        hrDrift: r.hr_drift ?? null,
        ambientTempC: r.ambient_temp_c ?? null,
        elevationGainM: r.elevation_gain_m ?? null,
        kmSplits: r.km_splits ?? null,
        activityType: r.activity_type,
        displayName: r.activity_name ?? formatActivityType(r.activity_type),
        workoutName: r.activity_name ?? undefined,
      };
    }

    // Densify: emit a Week for every index from 0 to maxIdx, even if empty.
    // _resolveWeekForDate uses array-index lookup keyed on date offset, so a
    // sparse array (missing rest weeks) misaligns every week after the first
    // gap — every chart bar then misses or falls through to seedDaily.
    const maxIdx = Math.max(...Array.from(weekMap.keys()), -1);
    const reconstructedWeeks: any[] = [];
    for (let i = 0; i <= maxIdx; i++) {
      reconstructedWeeks.push(weekMap.get(i) ?? {
        w: i + 1,
        ph: 'base',
        rated: {},
        skip: [],
        cross: [],
        wkGain: 0,
        workoutMods: [],
        adjustments: [],
        unspentLoad: 0,
        extraRunLoad: 0,
        garminActuals: {},
        adhocWorkouts: [],
        garminMatched: {},
      });
    }

    // Replace any prior archive with the same planStartDate (e.g. an earlier
    // run of this same recovery that emitted a sparse, mis-indexed weeks array
    // — _resolveWeekForDate iterates archives in order and the broken entry
    // would otherwise keep winning). Cap matches the initialization helper
    // (MAX_ARCHIVED_PLANS = 12) so the two paths stay in sync.
    const { MAX_ARCHIVED_PLANS } = await import('@/state/initialization');
    const existing = ((s as any).previousPlanWks ?? []).filter(
      (a: any) => a.planStartDate !== archivePlanStartISO,
    );
    existing.push({
      planStartDate: archivePlanStartISO,
      weeks: reconstructedWeeks,
      archivedAt: new Date().toISOString(),
    });
    (s as any).previousPlanWks = existing.slice(-MAX_ARCHIVED_PLANS);
    (s as any).lastHistoryAutoRestoreISO = new Date().toISOString();
    saveState();

    console.log(`[RestoreHistory] Reconstructed ${reconstructedWeeks.length} weeks (${weekMap.size} non-empty) from ${activityRows.length} activities, anchored at ${archivePlanStartISO}.`);
    return { activitiesRecovered: activityRows.length, weeksReconstructed: reconstructedWeeks.length };
  } catch (err) {
    console.error('[RestoreHistory] Failed:', err);
    return { activitiesRecovered: 0, weeksReconstructed: 0 };
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

/**
 * Find and delete duplicate rows in `garmin_activities` for the current user.
 *
 * Two rows are duplicates when their `start_time` is within 10 minutes AND either
 * shares the same `activity_type` OR has duration ratios within 15%. Mirrors the
 * in-state dedup window used by `matchAndAutoComplete` so any duplicate group the
 * matcher would have collapsed in `wk.garminActuals` is collapsed at the source too.
 *
 * Keeper selection per group:
 *   1. Strava rows beat Garmin rows (`garmin_id` starts with 'strava-').
 *   2. Among same-source rows, prefer the one with iTRIMP populated, then
 *      polyline, then longest duration. This keeps the richest signal.
 * All other rows in the group are deleted.
 *
 * Idempotent: gated by `s.dbDedupCompletedAt` (re-runs after 30 days). Safe to
 * call from startup — a 90-day window is sufficient since duplicates only enter
 * via active sync and old ones would have been cleaned by prior runs.
 *
 * Returns counts so the caller can log a summary; does NOT touch local state
 * beyond the timestamp.
 */
export async function cleanupDbDuplicates(daysBack = 90): Promise<{ groups: number; deleted: number }> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return { groups: 0, deleted: 0 };

    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    const sinceISO = since.toISOString();

    const { data, error } = await supabase
      .from('garmin_activities')
      .select('garmin_id, activity_type, start_time, duration_sec, itrimp, polyline')
      .eq('user_id', userId)
      .gte('start_time', sinceISO)
      .order('start_time', { ascending: true });

    if (error) {
      console.warn('[DbDedup] Query failed:', error.message);
      return { groups: 0, deleted: 0 };
    }
    const rows = (data ?? []) as Array<{
      garmin_id: string;
      activity_type: string | null;
      start_time: string;
      duration_sec: number | null;
      itrimp: number | null;
      polyline: string | null;
    }>;
    if (rows.length < 2) {
      const s = getMutableState();
      s.dbDedupCompletedAt = new Date().toISOString();
      saveState();
      return { groups: 0, deleted: 0 };
    }

    // Group rows where start_time is within 10 min AND (same type OR duration ratio < 15%).
    // Single pass: each row joins the most recent group whose anchor matches.
    const TEN_MIN_MS = 10 * 60 * 1000;
    type Row = (typeof rows)[number];
    const groups: Row[][] = [];
    for (const row of rows) {
      const ms = new Date(row.start_time).getTime();
      let placed = false;
      for (const g of groups) {
        const anchor = g[0];
        const anchorMs = new Date(anchor.start_time).getTime();
        if (Math.abs(ms - anchorMs) > TEN_MIN_MS) continue;
        const sameType = !!row.activity_type && row.activity_type === anchor.activity_type;
        let durSimilar = false;
        if (row.duration_sec && anchor.duration_sec && row.duration_sec > 0 && anchor.duration_sec > 0) {
          const ratio = Math.abs(row.duration_sec - anchor.duration_sec) / Math.max(row.duration_sec, anchor.duration_sec);
          durSimilar = ratio < 0.15;
        }
        if (sameType || durSimilar) { g.push(row); placed = true; break; }
      }
      if (!placed) groups.push([row]);
    }

    const dupGroups = groups.filter(g => g.length > 1);
    if (dupGroups.length === 0) {
      const s = getMutableState();
      s.dbDedupCompletedAt = new Date().toISOString();
      saveState();
      console.log('[DbDedup] No duplicates found.');
      return { groups: 0, deleted: 0 };
    }

    // Pick keeper per group. Strava > Garmin; richer (iTRIMP, polyline, longest) wins.
    const toDelete: string[] = [];
    for (const g of dupGroups) {
      const ranked = [...g].sort((a, b) => {
        const aStrava = a.garmin_id.startsWith('strava-') ? 1 : 0;
        const bStrava = b.garmin_id.startsWith('strava-') ? 1 : 0;
        if (aStrava !== bStrava) return bStrava - aStrava;
        const aTrimp = a.itrimp != null && a.itrimp > 0 ? 1 : 0;
        const bTrimp = b.itrimp != null && b.itrimp > 0 ? 1 : 0;
        if (aTrimp !== bTrimp) return bTrimp - aTrimp;
        const aPoly = a.polyline ? 1 : 0;
        const bPoly = b.polyline ? 1 : 0;
        if (aPoly !== bPoly) return bPoly - aPoly;
        return (b.duration_sec ?? 0) - (a.duration_sec ?? 0);
      });
      const [keep, ...drop] = ranked;
      console.log(`[DbDedup] Group of ${g.length} (${keep.activity_type ?? '?'} @ ${keep.start_time}) — keeping ${keep.garmin_id}, dropping ${drop.map(d => d.garmin_id).join(', ')}`);
      for (const d of drop) toDelete.push(d.garmin_id);
    }

    if (toDelete.length === 0) {
      const s = getMutableState();
      s.dbDedupCompletedAt = new Date().toISOString();
      saveState();
      return { groups: dupGroups.length, deleted: 0 };
    }

    // Delete in chunks of 100 to keep the IN-list reasonable.
    const CHUNK = 100;
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const chunk = toDelete.slice(i, i + CHUNK);
      const { error: delError } = await supabase
        .from('garmin_activities')
        .delete()
        .eq('user_id', userId)
        .in('garmin_id', chunk);
      if (delError) {
        console.warn(`[DbDedup] Delete chunk ${i / CHUNK + 1} failed:`, delError.message);
        break;
      }
      deleted += chunk.length;
    }

    console.log(`[DbDedup] Removed ${deleted} duplicate row(s) across ${dupGroups.length} group(s).`);
    const s = getMutableState();
    s.dbDedupCompletedAt = new Date().toISOString();
    saveState();
    return { groups: dupGroups.length, deleted };
  } catch (e: any) {
    console.warn('[DbDedup] Unexpected error:', e?.message ?? e);
    return { groups: 0, deleted: 0 };
  }
}
