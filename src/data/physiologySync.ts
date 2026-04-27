/**
 * Physiology Sync — pulls daily metrics from Supabase Edge Function
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
import { recomputeLT } from './ltSync';

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
  maxHR: number | null;
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
 * Safe to call at any time — returns all-null on error so the app still loads.
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

    // VO2max: prefer latestPhysio.vo2_max_running (running-specific, from Garmin's
    // userMetrics endpoint — matches what Garmin Connect shows). Fall back to
    // daily_metrics.vo2max, which is the generic dailies value and can include
    // cycling/cardio estimates that diverge from Running VO2 Max.
    //
    // Walk backwards through the daily rows to find the most recent *non-null*
    // vo2max — Garmin only stamps vo2Max on days when the value changes, so the
    // latest row is usually null and the real value lives a few days back.
    let latestDailyVo2: number | null = null;
    let latestDailyVo2Date: string | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i].vo2max;
      if (v != null && v > 0) {
        latestDailyVo2 = v;
        latestDailyVo2Date = rows[i].calendar_date;
        break;
      }
    }
    const vo2Value = (data.latestPhysio?.vo2_max_running != null && data.latestPhysio.vo2_max_running > 0)
      ? data.latestPhysio.vo2_max_running
      : latestDailyVo2;

    if (vo2Value != null && vo2Value > 0) {
      result.vo2 = vo2Value;
      s.vo2 = vo2Value;
      changed = true;
    } else if (s.vo2 != null && rows.length > 0) {
      // Garmin IS returning daily rows but none of them carry a vo2Max value and
      // physiology_snapshots has no userMetrics row either. s.vo2 is almost
      // certainly a stale wizard seed (or a value from an older Garmin connection).
      // Clear it so the UI falls back to computeCurrentVDOT() rather than pinning
      // a number that never updates. We only clear when rows.length > 0 to avoid
      // wiping the seed for users who haven't connected Garmin at all.
      console.log(`[PhysiologySync] Clearing stale s.vo2=${s.vo2} — ${rows.length} daily rows returned, none carried vo2max`);
      s.vo2 = undefined as unknown as number;
      changed = true;
    }

    if (latest.resting_hr != null && latest.resting_hr > 0) {
      result.restingHR = latest.resting_hr;
      s.restingHR = latest.resting_hr;
      changed = true;
    }

    // Use all-time peak HR from the envelope (queried across all garmin_activities)
    if (data.maxHR != null && data.maxHR > 0) {
      result.maxHR = data.maxHR;
      s.maxHR = data.maxHR;
      changed = true;
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
    // the latest dailies row's date. Used by recomputeLT to gate Garmin freshness.
    const garminLT = (ltPaceValue != null && ltPaceValue > 0) ? {
      ltPaceSecKm: ltPaceValue,
      ltHR: ltHRValue ?? null,
      asOf: (data.latestPhysio?.calendar_date ?? latest.calendar_date ?? new Date().toISOString().slice(0, 10)),
    } : null;

    // Hand off to ltSync — it builds derive inputs from PBs + activities,
    // applies the override > Garmin > derived priority, and surfaces a
    // suggestion if Garmin and derived disagree by >10s/km.
    const action = recomputeLT(s, { garmin: garminLT });
    if (action !== 'none') {
      result.ltPace = s.lt ?? null;
      result.ltHR = s.ltHR ?? null;
      changed = true;
    }
    if (action === 'pending') {
      console.warn(`[PhysiologySync] LT conflict (>10s/km) — surfacing suggestion: garmin=${garminLT?.ltPaceSecKm}s/km derived=${s.ltSuggestion?.derived.ltPaceSecKm.toFixed(0)}s/km`);
    }

    // Store up to 28 days of history for recovery score baseline and physiology dashboard.
    // 28 days is required so computeRecoveryScore() has enough HRV/sleep readings to
    // build a personal baseline (needs ≥3 readings in its 28-day window).
    if (days > 1 && rows.length > 0) {
      s.physiologyHistory = rows
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
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-28);
      changed = true;
    }

    if (changed) {
      saveState();
      console.log(`[PhysiologySync] State updated: vo2=${result.vo2} rhr=${result.restingHR} maxHR=${result.maxHR} ltPace=${result.ltPace} ltHR=${result.ltHR}`);
    }
    console.log(`[PhysiologySync] sources: latestPhysio.vo2_max_running=${data.latestPhysio?.vo2_max_running ?? 'null'} dailyRows=${rows.length} latest.vo2max=${latest.vo2max ?? 'null'} latestDailyVo2=${latestDailyVo2 ?? 'null'}@${latestDailyVo2Date ?? 'n/a'} — s.vo2=${s.vo2}`);

    return result;
  } catch (err) {
    // Non-fatal — app continues without fresh physiology data
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
