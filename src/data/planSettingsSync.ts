/**
 * Plan Settings Sync — backs up the user's plan state to Supabase so it
 * survives a localStorage wipe (e.g. after a device change or accidental reset).
 *
 * savePlanSettings()      — called fire-and-forget inside saveState()
 * restorePlanFromSupabase() — called in main.ts only when localStorage is empty
 */

import { supabase } from './supabaseClient';
import { getState } from '@/state/store';
import type { SimulatorState } from '@/types';

const STATE_KEY = 'marathonSimulatorState';

/**
 * Keys excluded from the snapshot — these are large arrays that are
 * re-fetched from Strava/Garmin on first sync after a restore.
 */
const EXCLUDE_KEYS: (keyof SimulatorState)[] = [
  'historicWeeklyTSS',
  'historicWeeklyRawTSS',
  'historicWeeklyKm',
  'historicWeeklyZones',
  'extendedHistoryTSS',
  'extendedHistoryKm',
  'extendedHistoryZones',
  'extendedHistoryWeeks',
  'physiologyHistory',
  'stravaHistoryFetched', // reset to false so backfill re-runs on restore
];

/**
 * Back up the current plan state to Supabase.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export async function savePlanSettings(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const state = getState();
    if (!state.hasCompletedOnboarding) return; // don't back up mid-wizard state

    const snapshot = { ...state } as Record<string, unknown>;
    for (const key of EXCLUDE_KEYS) delete snapshot[key];

    const { error } = await supabase
      .from('user_plan_settings')
      .upsert({
        user_id: user.id,
        state_snapshot: snapshot,
        updated_at: new Date().toISOString(),
      });

    if (error) console.warn('[PlanSettingsSync] save error:', error.message);
  } catch (e) {
    console.warn('[PlanSettingsSync] save failed:', e);
  }
}

/**
 * Restore plan state from Supabase into localStorage.
 * Called only when localStorage is empty (plan lost).
 * Returns true if a snapshot was found and written.
 */
export async function restorePlanFromSupabase(): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { data, error } = await supabase
      .from('user_plan_settings')
      .select('state_snapshot, updated_at')
      .eq('user_id', user.id)
      .single();

    if (error || !data?.state_snapshot) return false;

    localStorage.setItem(STATE_KEY, JSON.stringify(data.state_snapshot));
    console.log('[PlanSettingsSync] Restored plan from Supabase backup (saved', data.updated_at, ')');
    return true;
  } catch (e) {
    console.warn('[PlanSettingsSync] restore failed:', e);
    return false;
  }
}
