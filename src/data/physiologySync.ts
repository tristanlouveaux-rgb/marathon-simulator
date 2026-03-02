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

/** Shape returned by the sync-physiology-snapshot Edge Function */
interface PhysiologyRow {
  vo2max?: number | null;
  resting_hr?: number | null;
  hrv_rmssd?: number | null;
  max_hr?: number | null;
  lt_pace_sec_km?: number | null;
  calendar_date?: string;
  sleep_score?: number | null;
  avg_stress_level?: number | null;
}

/**
 * Build a RecoveryEntry from a single PhysiologyDayEntry.
 * Uses Garmin stress level (inverted) as readiness and RMSSD for HRV status.
 */
export function buildRecoveryEntryFromPhysio(physio: PhysiologyDayEntry): RecoveryEntry {
  return {
    date: physio.date,
    sleepScore: physio.sleepScore ?? 50,
    readiness: physio.stressAvg != null ? Math.round(100 - physio.stressAvg) : undefined,
    hrvStatus: physio.hrvRmssd != null ? rmssdToHrvStatus(physio.hrvRmssd) : undefined,
    source: 'garmin',
  };
}

/** Values actually received from Garmin via this sync call (null = not in Supabase yet) */
export interface PhysiologySnapshot {
  vo2: number | null;
  restingHR: number | null;
  maxHR: number | null;
  ltPace: number | null; // sec/km
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
  const empty: PhysiologySnapshot = { vo2: null, restingHR: null, maxHR: null, ltPace: null };
  try {
    const data = await callEdgeFunction<PhysiologyRow[] | PhysiologyRow>(
      'sync-physiology-snapshot',
      { days },
    );

    // Normalise: function may return a single object or an array
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0) return empty;

    // Pick the newest row (last in array, or first if pre-sorted desc)
    const latest = rows[rows.length - 1];
    if (!latest) return empty;

    const s = getMutableState();
    let changed = false;

    const result: PhysiologySnapshot = { vo2: null, restingHR: null, maxHR: null, ltPace: null };

    if (latest.vo2max != null && latest.vo2max > 0) {
      result.vo2 = latest.vo2max;
      s.vo2 = latest.vo2max;
      changed = true;
    }

    if (latest.resting_hr != null && latest.resting_hr > 0) {
      result.restingHR = latest.resting_hr;
      s.restingHR = latest.resting_hr;
      changed = true;
    }

    if (latest.max_hr != null && latest.max_hr > 0) {
      result.maxHR = latest.max_hr;
      s.maxHR = latest.max_hr;
      changed = true;
    }

    if (latest.lt_pace_sec_km != null && latest.lt_pace_sec_km > 0) {
      result.ltPace = latest.lt_pace_sec_km;
      s.lt = latest.lt_pace_sec_km;
      changed = true;
    }

    // Store 7-day history for physiology dashboard card
    if (days > 1 && rows.length > 0) {
      s.physiologyHistory = rows
        .filter(r => r.calendar_date)
        .map((r): PhysiologyDayEntry => ({
          date: r.calendar_date!,
          restingHR: r.resting_hr ?? undefined,
          hrvRmssd: r.hrv_rmssd ?? undefined,
          vo2max: r.vo2max ?? undefined,
          sleepScore: r.sleep_score ?? undefined,
          stressAvg: r.avg_stress_level ?? undefined,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-7);
      changed = true;
    }

    if (changed) {
      saveState();
      console.log('[PhysiologySync] State updated:', result);
    }

    return result;
  } catch (err) {
    // Non-fatal — app continues without fresh physiology data
    console.warn('[PhysiologySync] Failed to sync:', err);
    return empty;
  }
}
