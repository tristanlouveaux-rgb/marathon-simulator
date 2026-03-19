import { createClient } from '@supabase/supabase-js';

/** Supabase project config — values injected by Vite from .env.local */
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
export const SUPABASE_FUNCTIONS_BASE = import.meta.env.VITE_SUPABASE_FUNCTIONS_BASE as string;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/** Supabase client — manages auth sessions automatically via localStorage */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Get a valid authenticated session, refreshing if needed.
 * Throws 'SESSION_EXPIRED' if no valid session can be obtained.
 */
export async function getValidSession() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;

  // Return cached session only if it won't expire within the next 60 seconds
  if (session?.access_token) {
    const expiresAt = session.expires_at ?? 0;
    if (expiresAt > Math.floor(Date.now() / 1000) + 60) {
      return session;
    }
  }

  // Token missing or about to expire — refresh
  const { data: refreshed, error } = await supabase.auth.refreshSession();
  if (error || !refreshed.session) {
    throw new Error('SESSION_EXPIRED');
  }
  return refreshed.session;
}

/**
 * Get the current user's access token.
 * Throws 'SESSION_EXPIRED' if no valid session exists.
 */
export async function getAccessToken(): Promise<string> {
  const session = await getValidSession();
  return session.access_token;
}

/** Cached Garmin connection status — null means not yet checked */
let _garminConnected: boolean | null = null;

/**
 * Check whether the current user has a Garmin connection (row in garmin_tokens).
 * Result is cached after first successful check.
 * If the token is expired, attempts an automatic refresh before returning.
 */
export async function isGarminConnected(): Promise<boolean> {
  if (_garminConnected !== null) return _garminConnected;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/garmin_tokens?select=user_id,expires_at&limit=1`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const expiresAt = rows[0].expires_at;
        const expiresAtMs = expiresAt ? new Date(expiresAt).getTime() : 0;
        const isExpired = expiresAtMs < Date.now();
        // Refresh if: already expired, expiring within 24h, or expires_at was never stored (null → 0)
        const shouldRefresh = !expiresAt || expiresAtMs < Date.now() + 24 * 60 * 60 * 1000;
        if (shouldRefresh) {
          const refreshed = await refreshGarminToken();
          if (!refreshed && isExpired) {
            // Only fail hard if token is already expired AND refresh didn't work
            _garminConnected = false;
            return false;
          }
          // If refresh failed but token hasn't expired yet, stay connected and retry next launch
        }
        _garminConnected = true;
      } else {
        _garminConnected = false;
      }
    } else {
      _garminConnected = false;
    }
  } catch {
    _garminConnected = false;
  }
  return _garminConnected;
}

/**
 * Call the garmin-refresh-token edge function to refresh expired Garmin OAuth tokens.
 * Resets the Garmin cache on success so subsequent checks re-query.
 */
export async function refreshGarminToken(): Promise<boolean> {
  try {
    const result = await callEdgeFunction<{ ok: boolean }>('garmin-refresh-token', {});
    if (result.ok) {
      resetGarminCache();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Reset the cached Garmin connection flag (e.g. after connecting) */
export function resetGarminCache(): void {
  _garminConnected = null;
}

/**
 * Trigger the garmin-backfill edge function to pull historic dailies + sleep.
 * Fire-and-forget — logs success/failure but does not throw.
 * @param weeks Number of weeks to backfill (default 8)
 */
/**
 * Trigger the garmin-backfill edge function to pull historic dailies + sleep.
 * Garmin Health API is push-only — the pull API returns 0 rows.
 * We guard with a localStorage flag so we only attempt once per device.
 * Call resetGarminBackfillGuard() to force a retry (e.g. after re-auth).
 */
export async function triggerGarminBackfill(weeks = 8): Promise<void> {
  const GUARD_KEY = 'mosaic_garmin_backfill_empty';
  if (localStorage.getItem(GUARD_KEY) === '1') {
    console.log('[garmin-backfill] Skipped — previous run returned 0 rows (push-only API)');
    return;
  }
  try {
    const result = await callEdgeFunction<{ ok: boolean; days: number; sleepDays: number }>(
      'garmin-backfill',
      { weeks },
    );
    if (result.ok) {
      console.log(`[garmin-backfill] Done — ${result.days} daily rows, ${result.sleepDays} sleep rows`);
      if (result.days === 0 && result.sleepDays === 0) {
        localStorage.setItem(GUARD_KEY, '1');
        console.log('[garmin-backfill] API returned 0 rows — guarding future runs');
      }
    } else {
      console.warn('[garmin-backfill] Returned ok:false');
    }
  } catch (e) {
    console.warn('[garmin-backfill] Failed (non-fatal):', e);
  }
}

/** Reset the backfill guard so it runs again on next launch */
export function resetGarminBackfillGuard(): void {
  localStorage.removeItem('mosaic_garmin_backfill_empty');
}

/**
 * Re-fetch the last 2 days of Garmin sleep/biometric data.
 * Bypasses the backfill guard — safe to call daily to pick up today's sleep
 * score after Garmin's server-side processing completes (usually 1–4h post-wake).
 */
export async function refreshRecentSleepScores(): Promise<void> {
  try {
    const result = await callEdgeFunction<{ ok: boolean; days: number; sleepDays: number }>(
      'garmin-backfill',
      { weeks: 1 },
    );
    if (result.ok) {
      console.log(`[garmin-sleep-refresh] Done — ${result.sleepDays} sleep rows`);
    }
  } catch (e) {
    console.warn('[garmin-sleep-refresh] Failed (non-fatal):', e);
  }
}

/** Cached Strava connection status — null means not yet checked */
let _stravaConnected: boolean | null = null;

/**
 * Check whether the current user has a Strava connection (row in strava_tokens).
 * Result is cached after first successful check.
 */
export async function isStravaConnected(): Promise<boolean> {
  if (_stravaConnected !== null) return _stravaConnected;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/strava_tokens?select=user_id&limit=1`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
    if (res.ok) {
      const rows = await res.json();
      _stravaConnected = Array.isArray(rows) && rows.length > 0;
    } else {
      _stravaConnected = false;
    }
  } catch {
    _stravaConnected = false;
  }
  return _stravaConnected;
}

/** Reset the cached Strava connection flag (e.g. after connecting/disconnecting) */
export function resetStravaCache(): void {
  _stravaConnected = null;
}

/**
 * Call a Supabase Edge Function via plain fetch.
 * Uses the real user JWT when available.
 */
export async function callEdgeFunction<T = unknown>(
  fnName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const url = `${SUPABASE_FUNCTIONS_BASE}/${fnName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Edge function ${fnName} failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}
