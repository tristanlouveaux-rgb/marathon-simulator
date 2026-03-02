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
 */
export async function isGarminConnected(): Promise<boolean> {
  if (_garminConnected !== null) return _garminConnected;
  try {
    const token = await getAccessToken();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/garmin_tokens?select=user_id&limit=1`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
    if (res.ok) {
      const rows = await res.json();
      _garminConnected = Array.isArray(rows) && rows.length > 0;
    } else {
      _garminConnected = false;
    }
  } catch {
    _garminConnected = false;
  }
  return _garminConnected;
}

/** Reset the cached Garmin connection flag (e.g. after connecting) */
export function resetGarminCache(): void {
  _garminConnected = null;
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
