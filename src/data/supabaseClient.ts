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
  if (!error && refreshed.session) {
    return refreshed.session;
  }

  // Refresh failed — last resort, sign in anonymously so the user isn't stranded.
  console.warn('[auth] Session refresh failed, attempting anonymous sign-in', error);
  await supabase.auth.signOut().catch(() => {});
  const { data: anon, error: anonError } = await supabase.auth.signInAnonymously();
  if (anonError || !anon.session) {
    console.error('[auth] Anonymous sign-in also failed', anonError);
    throw new Error('SESSION_EXPIRED');
  }
  return anon.session;
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
 * Trigger the garmin-backfill edge function.
 *
 * Backfill now uses Garmin's webhook push model: the edge function POSTs to
 * /backfill/{type} endpoints and Garmin delivers data asynchronously via the
 * garmin-webhook function. That means calling this function doesn't return
 * data synchronously — it queues requests. New data lands in DB minutes later
 * and is read by syncPhysiologySnapshot on the next launch.
 *
 * Throttling rules:
 * - Fires EXACTLY ONCE per OAuth connect (resetGarminBackfillGuard clears the
 *   stamp so the next launch re-runs backfill). Subsequent launches no-op.
 * - Day-to-day gap recovery is handled server-side by the garmin-reconcile
 *   cron (runs nightly). Client-side launch calls no longer poll every 2h,
 *   which previously caused Garmin's 100-req/min app-wide rate limit to trip
 *   when many users opened the app simultaneously.
 * - Bumping MIGRATION_KEY forces every user to fire backfill once on next
 *   launch so code changes (e.g. new endpoint types) reach everyone.
 */
/** Shared across backfill + reconcile — if set, both back off until this epoch (ms). */
const GARMIN_COOLDOWN_KEY = 'mosaic_garmin_cooldown_until';
/** Garmin's rolling 1-min rate-limit window + margin — back off this long on 429/throttle. */
const GARMIN_COOLDOWN_MS = 120_000;

function inGarminCooldown(): number {
  const until = Number(localStorage.getItem(GARMIN_COOLDOWN_KEY) ?? '0');
  return until > Date.now() ? until : 0;
}

function setGarminCooldown(): void {
  localStorage.setItem(GARMIN_COOLDOWN_KEY, String(Date.now() + GARMIN_COOLDOWN_MS));
}

export async function triggerGarminBackfill(weeks = 8): Promise<void> {
  const LAST_RUN_KEY = 'mosaic_garmin_backfill_last_run';
  const MIGRATION_KEY = 'mosaic_garmin_backfill_migration';
  const CURRENT_MIGRATION = 'v7-one-shot-backfill';

  // Migrate away from older guard keys
  localStorage.removeItem('mosaic_garmin_backfill_empty');
  localStorage.removeItem('mosaic_garmin_backfill_empty_until');

  const migrated = localStorage.getItem(MIGRATION_KEY) === CURRENT_MIGRATION;
  const lastRun = Number(localStorage.getItem(LAST_RUN_KEY) ?? '0');

  if (migrated && lastRun > 0) {
    console.log(`[garmin-backfill] Skipped — already ran once under migration ${CURRENT_MIGRATION} at ${new Date(lastRun).toISOString()}. Nightly reconcile handles gaps.`);
    return;
  }

  const cooldownUntil = inGarminCooldown();
  if (cooldownUntil) {
    console.log(`[garmin-backfill] Skipped — Garmin rate-limit cooldown until ${new Date(cooldownUntil).toISOString()}.`);
    return;
  }

  try {
    const result = await callEdgeFunction<{
      ok: boolean;
      rateLimited?: boolean;
      refreshStatus?: string;
      expiresAtBefore?: string | null;
      requests?: { dailies: number; sleeps: number; hrv: number; userMetrics: number };
      errorBodies?: { dailies?: string; sleeps?: string; hrv?: string; userMetrics?: string };
    }>('garmin-backfill', { weeks });
    const r = result.requests;
    const reqStr = r
      ? `dailies=${r.dailies} sleeps=${r.sleeps} hrv=${r.hrv} userMetrics=${r.userMetrics}`
      : 'no request data';
    if (result.ok) {
      console.log(`[garmin-backfill] Queued webhook backfills — ${reqStr} (refresh=${result.refreshStatus ?? '?'}). Data arrives via webhook over the next few minutes.`);
      localStorage.setItem(LAST_RUN_KEY, String(Date.now()));
      localStorage.setItem(MIGRATION_KEY, CURRENT_MIGRATION);
    } else {
      // Any request failed — do NOT lock in the migration guard. A later launch
      // will retry (after cooldown, if rate-limited).
      console.warn(`[garmin-backfill] Partial failure — ${reqStr}${result.rateLimited ? ' (rate-limited, backing off)' : ''}`);
      const eb = result.errorBodies ?? {};
      for (const [k, v] of Object.entries(eb)) {
        if (v) console.warn(`[garmin-backfill] ${k} error body: ${v}`);
      }
      if (result.rateLimited) setGarminCooldown();
    }
  } catch (e) {
    console.warn('[garmin-backfill] Failed (non-fatal):', e);
  }
}

/** Reset the backfill guard so it runs again on next launch */
export function resetGarminBackfillGuard(): void {
  localStorage.removeItem('mosaic_garmin_backfill_last_run');
  localStorage.removeItem('mosaic_garmin_backfill_migration');
  localStorage.removeItem('mosaic_garmin_backfill_empty_until');
  localStorage.removeItem('mosaic_garmin_backfill_empty');
  localStorage.removeItem(GARMIN_COOLDOWN_KEY);
}

/**
 * Manual user-triggered reconcile — asks Garmin to re-push the last N days of
 * data for THIS user only. Used by the "Sync" button in Account settings so
 * users can pull missing days on demand without waiting for the nightly cron.
 *
 * Queues the request via the garmin-reconcile edge function in user mode (auth
 * is the user's Supabase JWT, not the cron secret). Garmin delivers the data
 * via webhook minutes later; subsequent syncPhysiologySnapshot calls will see
 * the fresh rows.
 */
export async function triggerGarminReconcile(lookbackDays = 3): Promise<{ ok: boolean; stale: number; succeeded: number; failed: number; rateLimited?: boolean }> {
  const cooldownUntil = inGarminCooldown();
  if (cooldownUntil) {
    console.log(`[garmin-reconcile] Skipped — Garmin rate-limit cooldown until ${new Date(cooldownUntil).toISOString()}.`);
    return { ok: false, stale: 0, succeeded: 0, failed: 0, rateLimited: true };
  }
  try {
    const result = await callEdgeFunction<{
      ok: boolean;
      succeeded?: number;
      failed?: number;
      stale?: number;
      rateLimited?: number;
      results?: Array<{ ok: boolean; reason?: string }>;
    }>('garmin-reconcile', { lookbackDays });
    const succeeded = result.succeeded ?? 0;
    const failed = result.failed ?? 0;
    const stale = result.stale ?? 0;
    const rateLimited = (result.rateLimited ?? 0) > 0;
    console.log(`[garmin-reconcile] user-mode queued — stale=${stale} ok=${succeeded} fail=${failed} rate=${result.rateLimited ?? 0}. Data lands via webhook.`);
    if (rateLimited) setGarminCooldown();
    return { ok: result.ok, stale, succeeded, failed, rateLimited };
  } catch (e) {
    console.warn('[garmin-reconcile] Failed (non-fatal):', e);
    return { ok: false, stale: 0, succeeded: 0, failed: 0 };
  }
}

/**
 * Re-fetch the last 2 days of Garmin sleep/biometric data.
 * Bypasses the backfill guard — safe to call daily to pick up today's sleep
 * score after Garmin's server-side processing completes (usually 1–4h post-wake).
 *
 * Respects the shared Garmin cooldown. Called on every launch when today's
 * sleep is missing, so without this check it becomes a rate-limit amplifier
 * during throttled windows.
 */
export async function refreshRecentSleepScores(): Promise<void> {
  const cooldownUntil = inGarminCooldown();
  if (cooldownUntil) {
    console.log(`[garmin-sleep-refresh] Skipped — Garmin rate-limit cooldown until ${new Date(cooldownUntil).toISOString()}.`);
    return;
  }
  try {
    const result = await callEdgeFunction<{ ok: boolean; rateLimited?: boolean; days: number; sleepDays: number }>(
      'garmin-backfill',
      { weeks: 1 },
    );
    if (result.rateLimited) setGarminCooldown();
    if (result.ok) {
      console.log(`[garmin-sleep-refresh] Done — ${result.sleepDays} sleep rows`);
    } else {
      console.warn(`[garmin-sleep-refresh] Partial failure${result.rateLimited ? ' (rate-limited, backing off)' : ''}`);
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
