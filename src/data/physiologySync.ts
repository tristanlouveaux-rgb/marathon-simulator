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
import { cv } from '@/calculations';

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
}

/** Full response envelope from sync-physiology-snapshot */
interface PhysiologyResponse {
  days: PhysiologyRow[];
  maxHR: number | null;
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
    if (rows.length === 0) return empty;

    // Pick the newest row (last in array, or first if pre-sorted desc)
    const latest = rows[rows.length - 1];
    if (!latest) return empty;

    const s = getMutableState();
    let changed = false;

    const result: PhysiologySnapshot = { vo2: null, restingHR: null, maxHR: null, ltPace: null, ltHR: null };

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

    // Use all-time peak HR from the envelope (queried across all garmin_activities)
    if (data.maxHR != null && data.maxHR > 0) {
      result.maxHR = data.maxHR;
      s.maxHR = data.maxHR;
      changed = true;
    }

    if (latest.lt_pace_sec_km != null && latest.lt_pace_sec_km > 0) {
      // Sanity check: derived VDOT from this LT pace must be within ±8 of s.v.
      // If it's further off, the Garmin LT measurement is stale or from a different
      // fitness level and should not overwrite s.lt (which would misguide physioAdj).
      const ltDerivedVdot = cv(10000, latest.lt_pace_sec_km * 10);
      const vdotDeviation = Math.abs(ltDerivedVdot - (s.v || 40));
      if (vdotDeviation <= 8) {
        result.ltPace = latest.lt_pace_sec_km;
        s.lt = latest.lt_pace_sec_km;
        changed = true;
      } else {
        console.warn(`[PhysiologySync] LT pace ${latest.lt_pace_sec_km}s/km (VDOT≈${ltDerivedVdot.toFixed(1)}) skipped — ${vdotDeviation.toFixed(1)} pts from s.v=${s.v}. Likely stale Garmin data.`);
      }
    }

    if (latest.lt_heart_rate != null && latest.lt_heart_rate > 0) {
      result.ltHR = latest.lt_heart_rate;
      s.ltHR = latest.lt_heart_rate;
      changed = true;
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
          ltPace: r.lt_pace_sec_km ?? undefined,
          ltHR: r.lt_heart_rate ?? undefined,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-28);
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
