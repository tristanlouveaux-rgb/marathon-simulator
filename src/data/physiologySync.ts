/**
 * Physiology Sync. Pulls daily metrics from Supabase Edge Function
 * and hydrates existing SimulatorState fields.
 *
 * Currently syncs: vo2max → s.vo2, resting_hr → s.restingHR
 * Also stores 7-day history for the physiology dashboard card.
 */

import { getMutableState, saveState } from '@/state';
import { callEdgeFunction } from './supabaseClient';
import type { PhysiologyDayEntry } from '@/types';
import { rmssdToHrvStatus } from '@/recovery/engine';
import type { RecoveryEntry } from '@/recovery/engine';
import { recomputeLT, LT_NOTIFY_THRESHOLD_SEC_KM } from './ltSync';
import { formatPace } from '@/utils/format';
import { applyCorroboratedMaxHR } from '@/calculations/max-hr-estimator';

/** Shape of a single day row from sync-physiology-snapshot */
interface PhysiologyRow {
  vo2max?: number | null;
  resting_hr?: number | null;
  hrv_rmssd?: number | null;
  max_hr?: number | null;
  lt_pace_sec_km?: number | null;
  lt_heart_rate?: number | null;
  calendar_date?: string;
  sleep_score?: number | null;
  sleep_duration_sec?: number | null;
  sleep_deep_sec?: number | null;
  sleep_rem_sec?: number | null;
  sleep_light_sec?: number | null;
  sleep_awake_sec?: number | null;
  avg_stress_level?: number | null;
  steps?: number | null;
  active_calories?: number | null;
  active_minutes?: number | null;
  highly_active_minutes?: number | null;
}

/** Full response envelope from sync-physiology-snapshot */
interface PhysiologyResponse {
  days: PhysiologyRow[];
  /** Legacy aggregate (p95 of session maxes). Only read when maxHRReadings is absent. */
  maxHR: number | null;
  /** Top session max-HR readings with dates — input to corroboratedMaxHR() */
  maxHRReadings?: { max_hr: number; date: string }[] | null;
  /** Latest physiology_snapshots row (no date filter) — for infrequent metrics like LT */
  latestPhysio: {
    calendar_date: string;
    vo2_max_running: number | null;
    lactate_threshold_pace: number | null;
    lt_heart_rate: number | null;
  } | null;
}

/**
 * Build a RecoveryEntry from a single PhysiologyDayEntry.
 * Uses stress level (inverted, Garmin-only) as readiness and RMSSD for HRV status.
 */
export function buildRecoveryEntryFromPhysio(
  physio: PhysiologyDayEntry,
  source: 'garmin' | 'apple' = 'garmin',
): RecoveryEntry {
  return {
    date: physio.date,
    sleepScore: physio.sleepScore ?? 50,
    readiness: physio.stressAvg != null ? Math.round(100 - physio.stressAvg) : undefined,
    hrvStatus: physio.hrvRmssd != null ? rmssdToHrvStatus(physio.hrvRmssd) : undefined,
    source,
  };
}

/** Values actually received from Garmin via this sync call (null = not in Supabase yet) */
export interface PhysiologySnapshot {
  vo2: number | null;
  restingHR: number | null;
  maxHR: number | null;
  ltPace: number | null; // sec/km
  ltHR: number | null;  // bpm
}

/**
 * Fetch the latest physiology snapshot and merge into state.
 * Returns only the values that were actually present in the Supabase response —
 * null means Garmin hasn't pushed that metric yet (not a stale cached value).
 *
 * Safe to call at any time. Returns all-null on error so the app still loads.
 *
 * @param days  How many days of history to request (default 1 = latest only)
 */
export async function syncPhysiologySnapshot(days = 1): Promise<PhysiologySnapshot> {
  const empty: PhysiologySnapshot = { vo2: null, restingHR: null, maxHR: null, ltPace: null, ltHR: null };
  try {
    const data = await callEdgeFunction<PhysiologyResponse>(
      'sync-physiology-snapshot',
      { days },
    );

    const rows = data.days ?? [];
    const hasRows = rows.length > 0;
    const hasLatestPhysio = data.latestPhysio != null;
    if (!hasRows && !hasLatestPhysio) return empty;

    // Pick the newest row (last in array, or first if pre-sorted desc)
    const latest = hasRows ? rows[rows.length - 1] : {} as PhysiologyRow;

    const s = getMutableState();
    let changed = false;

    const result: PhysiologySnapshot = { vo2: null, restingHR: null, maxHR: null, ltPace: null, ltHR: null };

    // VO2max: ONLY accept `physiology_snapshots.vo2_max_running` from Garmin's
    // userMetrics endpoint (matches the watch's "Running VO2 Max" screen).
    //
    // We deliberately do NOT fall back to `daily_metrics.vo2max`. The dailies
    // value is Garmin's generic cardio estimate and can carry cycling/cardio
    // values that diverge from the running-specific number on the watch face.
    // Historical bug: a stale dailies value (e.g. 53 from a cycling reading) was
    // sticking on `s.vo2` even when physiology_snapshots had a fresher running
    // value (56). If userMetrics has never pushed for this account, `s.vo2`
    // stays null and the UI falls through to computed VDOT, labelled "(est.)".
    const vo2Value = (data.latestPhysio?.vo2_max_running != null && data.latestPhysio.vo2_max_running > 0)
      ? data.latestPhysio.vo2_max_running
      : null;

    if (vo2Value != null) {
      result.vo2 = vo2Value;
      // Accept any increase. Accept a decline only if it's ≤ 5 points. A larger
      // overnight drop is almost always a Garmin data glitch, not real detraining.
      const currentVo2 = s.vo2 ?? 0;
      if (currentVo2 === 0 || vo2Value >= currentVo2 || (currentVo2 - vo2Value) <= 5) {
        s.vo2 = vo2Value;
        s.vo2UpdatedAt = new Date().toISOString().slice(0, 10);
        changed = true;
      } else {
        console.warn(`[PhysiologySync] Ignored VO2max drop ${currentVo2} → ${vo2Value} (>${5} point drop, likely bad data).`);
      }
    } else if (s.vo2 != null && (rows.length > 0 || hasLatestPhysio)) {
      // Sync ran successfully (we got rows or a latestPhysio row back) but
      // userMetrics has not delivered a running-VO2 value. Clear any stale
      // s.vo2 so the UI shows our own VDOT estimate rather than pinning a
      // possibly-wrong device number. Only clear when the sync actually
      // returned data. We don't want to wipe state on a transient empty
      // response (rate limit, network blip).
      console.log(`[PhysiologySync] Clearing stale s.vo2=${s.vo2} — physiology_snapshots has no vo2_max_running for this account`);
      s.vo2 = undefined as unknown as number;
      s.vo2UpdatedAt = undefined;
      changed = true;
    }

    // Walk backwards through daily rows to find the most recent non-null RHR.
    // Garmin populates resting_hr overnight after a sleep cycle, so today's row
    // is null until tomorrow's sync. Without the walk-back, fresh Garmin
    // connections leave s.restingHR undefined and gate off HR-calibrated VDOT.
    let latestRHR: number | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i].resting_hr;
      if (v != null && v > 0) { latestRHR = v; break; }
    }
    if (latestRHR != null) {
      result.restingHR = latestRHR;
      s.restingHR = latestRHR;
      changed = true;
    }

    // Max HR is a physiological ceiling. Only raise, never lower.
    // Estimate = highest corroborated session max (canonical helper — shared
    // with stravaSync and appleHealthSync so the ceiling can't depend on
    // which pipe a session arrived through).
    if (data.maxHRReadings?.length) {
      const readings = data.maxHRReadings.map(rd => ({ maxHR: rd.max_hr, date: rd.date }));
      const { estimate, changed: hrChanged } = applyCorroboratedMaxHR(s, readings, 'PhysiologySync');
      result.maxHR = estimate;
      if (hrChanged) changed = true;
    } else if (data.maxHR != null && data.maxHR > 0) {
      // Legacy edge-fn response (p95 aggregate, no readings). Up-only ratchet;
      // a lower p95 is expected (it tracks training mix, not the ceiling).
      result.maxHR = data.maxHR;
      if (data.maxHR > (s.maxHR ?? 0)) {
        s.maxHR = data.maxHR;
        changed = true;
      }
    }

    // LT pace: prefer the date-windowed latest, fall back to latestPhysio (all-time)
    const ltPaceValue = (latest.lt_pace_sec_km != null && latest.lt_pace_sec_km > 0)
      ? latest.lt_pace_sec_km
      : (data.latestPhysio?.lactate_threshold_pace ?? null);

    // LT heart rate: prefer the date-windowed latest, fall back to latestPhysio (all-time)
    const ltHRValue = (latest.lt_heart_rate != null && latest.lt_heart_rate > 0)
      ? latest.lt_heart_rate
      : (data.latestPhysio?.lt_heart_rate ?? null);

    // Garmin LT "as of" date: latestPhysio.calendar_date if it carried LT, else
    // the latest dailies row's date. Shown in the LT card provenance line.
    const garminLT = (ltPaceValue != null && ltPaceValue > 0) ? {
      ltPaceSecKm: ltPaceValue,
      ltHR: ltHRValue ?? null,
      asOf: (data.latestPhysio?.calendar_date ?? latest.calendar_date ?? new Date().toISOString().slice(0, 10)),
    } : null;

    // Hand off to ltSync. It builds derive inputs from PBs + activities and
    // applies the override > Garmin (until superseded) > derived priority.
    // Watch readings auto-apply; a meaningful shift gets a toast below.
    const prevLtPace = s.lt ?? null;
    const action = recomputeLT(s, { garmin: garminLT });
    if (action !== 'none') {
      result.ltPace = s.lt ?? null;
      result.ltHR = s.ltHR ?? null;
      changed = true;
    }
    // Adaptation transparency: a watch-driven LT shift of ≥10s/km changes
    // threshold prescriptions noticeably — say so, don't silently swap.
    if (action === 'garmin' && prevLtPace != null && s.lt != null
        && Math.abs(s.lt - prevLtPace) >= LT_NOTIFY_THRESHOLD_SEC_KM) {
      const unitPref = s.unitPref ?? 'km';
      import('@/ui/toast').then(({ showAssignmentToast }) => {
        showAssignmentToast([
          `Lactate threshold updated from your watch: ${formatPace(prevLtPace, unitPref)} → ${formatPace(s.lt!, unitPref)}.`,
        ]);
      }).catch(() => {});
      console.log(`[PhysiologySync] LT updated from Garmin: ${prevLtPace}s/km → ${s.lt}s/km`);
    }

    // Store up to 28 days of history for recovery score baseline and physiology dashboard.
    // 28 days is required so computeRecoveryScore() has enough HRV/sleep readings to
    // build a personal baseline (needs ≥3 readings in its 28-day window).
    //
    // MERGE by date, never wholesale replace. A short-window call (the sleep
    // poller and the foreground-resume sync use days=7) must not truncate the
    // 28-day baseline that the 90-day launch sync built. Garmin wins per-field
    // where it has data; fields it lacks keep their existing (e.g. Apple
    // gap-fill) values.
    if (days > 1 && rows.length > 0) {
      const incoming = rows
        .filter(r => r.calendar_date)
        .map((r): PhysiologyDayEntry => ({
          date: r.calendar_date!,
          restingHR: r.resting_hr ?? undefined,
          maxHR: r.max_hr ?? undefined,
          hrvRmssd: r.hrv_rmssd ?? undefined,
          vo2max: r.vo2max ?? undefined,
          sleepScore: r.sleep_score ?? undefined,
          sleepDurationSec: r.sleep_duration_sec ?? undefined,
          sleepDeepSec: r.sleep_deep_sec ?? undefined,
          sleepRemSec: r.sleep_rem_sec ?? undefined,
          sleepLightSec: r.sleep_light_sec ?? undefined,
          sleepAwakeSec: r.sleep_awake_sec ?? undefined,
          stressAvg: r.avg_stress_level ?? undefined,
          steps: r.steps ?? undefined,
          activeCalories: r.active_calories ?? undefined,
          activeMinutes: r.active_minutes ?? undefined,
          highlyActiveMinutes: r.highly_active_minutes ?? undefined,
          ltPace: r.lt_pace_sec_km ?? undefined,
          ltHR: r.lt_heart_rate ?? undefined,
        }));
      const byDate = new Map((s.physiologyHistory ?? []).map(e => [e.date, e]));
      for (const entry of incoming) {
        const prev = byDate.get(entry.date);
        if (!prev) {
          byDate.set(entry.date, entry);
          continue;
        }
        // Per-field: only overwrite with values Garmin actually sent.
        const defined = Object.fromEntries(
          Object.entries(entry).filter(([, v]) => v !== undefined),
        ) as Partial<PhysiologyDayEntry>;
        byDate.set(entry.date, { ...prev, ...defined });
      }
      s.physiologyHistory = [...byDate.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-28);
      changed = true;
    }

    if (changed) {
      saveState();
      console.log(`[PhysiologySync] State updated: vo2=${result.vo2} rhr=${result.restingHR} maxHR=${result.maxHR} ltPace=${result.ltPace} ltHR=${result.ltHR}`);
    }
    console.log(`[PhysiologySync] sources: latestPhysio.vo2_max_running=${data.latestPhysio?.vo2_max_running ?? 'null'}@${data.latestPhysio?.calendar_date ?? 'n/a'} dailyRows=${rows.length} — s.vo2=${s.vo2}`);

    return result;
  } catch (err) {
    // Non-fatal. App continues without fresh physiology data
    console.warn('[PhysiologySync] Failed to sync:', err);
    return empty;
  }
}

/**
 * Fetch today's step count from Garmin epoch summaries (15-min windows).
 * Updates today's entry in s.physiologyHistory so the strain ring can show
 * passive load as the day progresses.
 *
 * Safe to call at any time (launch, foreground resume, manual pull-to-refresh).
 * Silently skips if Garmin is not connected.
 *
 * Returns the step count, or null if the call failed or Garmin isn't connected.
 */
export async function syncTodaySteps(): Promise<number | null> {
  try {
    const data = await callEdgeFunction<{
      ok: boolean; steps: number; activeCalories: number;
      activeMinutes: number; highlyActiveMinutes: number; epochCount: number;
    }>('sync-today-steps', {});
    if (!data.ok) return null;

    const steps = data.steps ?? 0;
    const activeCalories = data.activeCalories ?? 0;
    const activeMinutes = data.activeMinutes ?? 0;
    const highlyActiveMinutes = data.highlyActiveMinutes ?? 0;
    const today = new Date().toISOString().split('T')[0];
    const s = getMutableState();

    // Update or insert today's entry in physiologyHistory
    const history = s.physiologyHistory ?? [];
    const todayIdx = history.findIndex(e => e.date === today);
    const patch = { steps, activeCalories, activeMinutes, highlyActiveMinutes };
    if (todayIdx >= 0) {
      history[todayIdx] = { ...history[todayIdx], ...patch };
    } else {
      history.push({ date: today, ...patch });
    }
    s.physiologyHistory = history.sort((a, b) => a.date.localeCompare(b.date));
    saveState();

    console.log(`[PhysiologySync] Today steps updated: ${steps} (${data.epochCount} epochs)`);
    return steps;
  } catch (err) {
    console.warn('[PhysiologySync] syncTodaySteps failed:', err);
    return null;
  }
}
