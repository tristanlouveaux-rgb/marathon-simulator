/**
 * Plan Settings Sync. Backs up the user's plan state to Supabase so it
 * survives a localStorage wipe (e.g. after a device change or accidental reset).
 *
 * savePlanSettings(). Called fire-and-forget inside saveState()
 * restorePlanFromSupabase(). Called in main.ts only when localStorage is empty
 */

import { supabase } from './supabaseClient';
import { getState } from '@/state/store';
import type { SimulatorState } from '@/types';

const STATE_KEY = 'marathonSimulatorState';
const STATE_OWNER_KEY = 'mosaic_state_owner_user_id';

/** Read the user_id that the current localStorage state was saved under. */
export function getLocalStateOwner(): string | null {
  return localStorage.getItem(STATE_OWNER_KEY);
}

/** Stamp the localStorage state with the user_id who owns it. */
export function setLocalStateOwner(userId: string | null): void {
  if (userId) localStorage.setItem(STATE_OWNER_KEY, userId);
  else localStorage.removeItem(STATE_OWNER_KEY);
}

/**
 * Keys excluded from the snapshot. These are large arrays that are
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
 * Fire-and-forget. Never throws, never blocks the caller.
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
    else setLocalStateOwner(user.id);
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
      .maybeSingle();

    // maybeSingle() returns data:null with no error when no row exists yet —
    // every new user's first launch, before their first save. .single() instead
    // returned a 406 (PostgREST can't coerce zero rows to a single object), which
    // was handled here but logged a noisy error on every new account.
    if (error || !data?.state_snapshot) return false;

    localStorage.setItem(STATE_KEY, JSON.stringify(data.state_snapshot));
    setLocalStateOwner(user.id);
    console.log('[PlanSettingsSync] Restored plan from Supabase backup (saved', data.updated_at, ')');
    return true;
  } catch (e) {
    console.warn('[PlanSettingsSync] restore failed:', e);
    return false;
  }
}

/**
 * Delete the user's plan backup from Supabase.
 *
 * Called from the plan-reset path. softResetState() only clears localStorage;
 * without this the stale cloud row survives and restorePlanFromSupabase()
 * (main.ts SIGNED_IN handler / empty-localStorage launch) writes the old plan
 * straight back, so the reset never sticks. Must be AWAITED before the reset's
 * location.reload() or the navigation cancels the in-flight delete.
 *
 * Best-effort: never throws. No-op for anonymous/sim sessions (no user).
 * Returns true if a row was deleted (or none existed), false on error.
 */
export async function deletePlanSettings(): Promise<boolean> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { error } = await supabase
      .from('user_plan_settings')
      .delete()
      .eq('user_id', user.id);

    if (error) {
      console.warn('[PlanSettingsSync] delete error:', error.message);
      return false;
    }
    setLocalStateOwner(null);
    console.log('[PlanSettingsSync] Deleted plan backup from Supabase (reset)');
    return true;
  } catch (e) {
    console.warn('[PlanSettingsSync] delete failed:', e);
    return false;
  }
}
