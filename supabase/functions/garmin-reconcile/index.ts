/**
 * Garmin Reconcile edge function.
 *
 * Nightly job that catches up Garmin data for users whose webhook has missed a
 * day. Replaces the client-side 2-hour launch-time backfill poll (which caused
 * Garmin's 100-req/min app-wide rate limit to trip as the user base grew).
 *
 * How it works:
 *   1. Find users who have a garmin_tokens row but no daily_metrics row for
 *      yesterday (UTC). These are the "stale" users.
 *   2. For each stale user (up to `limit`), refresh their OAuth token if needed
 *      and fire a small /backfill/dailies + /backfill/sleeps window for the
 *      last `lookbackDays` days. Garmin delivers the data via webhook minutes
 *      later and the garmin-webhook function writes it to the DB.
 *   3. Pacing: 2 seconds between users × 2 parallel requests each ≈ 60 req/min,
 *      comfortably under Garmin's 100/min app-wide limit.
 *   4. On 429 (rate limited), stop the run — the next cron cycle continues.
 *
 * Invocation:
 *   - Cron: POST with header `x-cron-secret: <RECONCILE_CRON_SECRET>`.
 *     Iterates all stale users (up to limit). Scheduled from pg_cron via a
 *     SQL migration.
 *   - Manual: POST with a user Bearer JWT. Reconciles only that user. Used by
 *     the "Resync" button in Account settings.
 *
 * Body (optional): { limit?: number (default 25, max 100),
 *                    lookbackDays?: number (default 3, max 14) }
 *
 * Returns: { ok, mode, yesterday, stale, processed, succeeded, failed,
 *            rateLimited, results[] }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GARMIN_API_BASE = "https://apis.garmin.com";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_LOOKBACK_DAYS = 3;
const MAX_LOOKBACK_DAYS = 14;
const PACE_MS = 3000; // Gap between users — 3 parallel requests/user × 20 users/min ≈ 60 req/min (under Garmin's 100/min cap)
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh if token expires within 5 min

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

interface GarminTokenRow {
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
}

interface BackfillResult {
  status: number;
  ok: boolean;
  body?: string;
}

/**
 * POST a /backfill/{type} request. Garmin replies 202 on success and pushes
 * data via webhook later. 409 = already queued, also treated as success.
 */
async function requestBackfill(
  type: string,
  accessToken: string,
  startEpoch: number,
  endEpoch: number,
): Promise<BackfillResult> {
  const url = `${GARMIN_API_BASE}/wellness-api/rest/backfill/${type}`
    + `?summaryStartTimeInSeconds=${startEpoch}`
    + `&summaryEndTimeInSeconds=${endEpoch}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Length": "0",
      },
    });
    const ok = res.status === 202 || res.status === 409;
    let body: string | undefined;
    if (!ok) body = (await res.text()).slice(0, 300);
    return { status: res.status, ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: `fetch_error: ${String(e).slice(0, 200)}` };
  }
}

interface RefreshedToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Exchange a refresh token for a new access token via Garmin's OAuth endpoint.
 */
async function refreshGarminToken(refreshToken: string): Promise<RefreshedToken | null> {
  try {
    const clientId = Deno.env.get("GARMIN_CLIENT_ID");
    const clientSecret = Deno.env.get("GARMIN_CLIENT_SECRET") ?? Deno.env.get("Garmin_client_secret");
    if (!clientId) {
      console.error("[garmin-reconcile] Missing GARMIN_CLIENT_ID");
      return null;
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    const res = await fetch("https://diauth.garmin.com/di-oauth2-service/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[garmin-reconcile] Token refresh failed ${res.status}: ${txt.slice(0, 200)}`);
      return null;
    }
    return await res.json() as RefreshedToken;
  } catch (e) {
    console.warn(`[garmin-reconcile] Refresh exception: ${String(e).slice(0, 200)}`);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // --- Auth: cron secret OR user JWT ---
    const cronSecretHeader = req.headers.get("x-cron-secret");
    const expectedCronSecret = Deno.env.get("RECONCILE_CRON_SECRET");
    const isCron = !!(cronSecretHeader && expectedCronSecret && cronSecretHeader === expectedCronSecret);

    let userIds: string[] = [];
    let mode: "cron" | "user" = "cron";

    if (!isCron) {
      const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      if (!jwt) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      const { data: { user }, error } = await supabase.auth.getUser(jwt);
      if (error || !user) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      userIds = [user.id];
      mode = "user";
    }

    // --- Parse params ---
    let limit = DEFAULT_LIMIT;
    let lookbackDays = DEFAULT_LOOKBACK_DAYS;
    try {
      const body = await req.json();
      if (typeof body.limit === "number" && body.limit > 0) {
        limit = Math.min(Math.floor(body.limit), MAX_LIMIT);
      }
      if (typeof body.lookbackDays === "number" && body.lookbackDays > 0) {
        lookbackDays = Math.min(Math.floor(body.lookbackDays), MAX_LOOKBACK_DAYS);
      }
    } catch (_) { /* defaults */ }

    // --- Compute yesterday (UTC) — matches daily_metrics.day_date storage ---
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    // --- Determine which users to reconcile ---
    if (isCron) {
      const { data: allTokens, error: tokenErr } = await supabase
        .from("garmin_tokens")
        .select("user_id, updated_at")
        .order("updated_at", { ascending: true, nullsFirst: true });
      if (tokenErr) {
        console.error("[garmin-reconcile] Failed to load tokens:", tokenErr);
        return jsonResponse({ ok: false, error: "token_query_failed" }, 500);
      }
      const allUserIds = (allTokens ?? []).map(t => t.user_id);
      if (allUserIds.length === 0) {
        return jsonResponse({ ok: true, mode, yesterday: yesterdayStr, stale: 0, processed: 0, succeeded: 0, failed: 0, rateLimited: 0, results: [] });
      }

      // Users WITH yesterday's daily_metrics row → not stale
      const { data: presentRows } = await supabase
        .from("daily_metrics")
        .select("user_id")
        .eq("day_date", yesterdayStr)
        .in("user_id", allUserIds);
      const present = new Set((presentRows ?? []).map(r => r.user_id));

      // Oldest-updated-first so long-dormant users get reconciled over time
      userIds = allUserIds.filter(id => !present.has(id)).slice(0, limit);
      console.log(`[garmin-reconcile] cron: ${allUserIds.length} tokens, ${present.size} fresh, ${allUserIds.length - present.size} stale, reconciling ${userIds.length}`);
    }

    if (userIds.length === 0) {
      return jsonResponse({ ok: true, mode, yesterday: yesterdayStr, stale: 0, processed: 0, succeeded: 0, failed: 0, rateLimited: 0, results: [] });
    }

    // --- Date range for each backfill request ---
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - lookbackDays);
    const startEpoch = Math.floor(start.getTime() / 1000);
    const endEpoch = Math.floor(now.getTime() / 1000);

    // --- Process each user, paced to respect Garmin's 100/min limit ---
    let succeeded = 0;
    let failed = 0;
    let rateLimited = 0;
    const results: Array<{ userId: string; ok: boolean; reason?: string }> = [];

    for (let i = 0; i < userIds.length; i++) {
      const userId = userIds[i];
      if (i > 0) await new Promise(r => setTimeout(r, PACE_MS));

      // Fetch fresh token row
      const { data: tokenRow } = await supabase
        .from("garmin_tokens")
        .select("access_token, refresh_token, expires_at")
        .eq("user_id", userId)
        .maybeSingle() as { data: GarminTokenRow | null };

      if (!tokenRow?.access_token) {
        failed++;
        results.push({ userId, ok: false, reason: "no_token" });
        continue;
      }

      let accessToken: string = tokenRow.access_token;
      const expiresAtMs = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
      const needsRefresh = !expiresAtMs || (expiresAtMs - Date.now() < REFRESH_BUFFER_MS);

      if (needsRefresh) {
        if (!tokenRow.refresh_token) {
          failed++;
          results.push({ userId, ok: false, reason: "expired_no_refresh" });
          continue;
        }
        const refreshed = await refreshGarminToken(tokenRow.refresh_token);
        if (!refreshed?.access_token) {
          failed++;
          results.push({ userId, ok: false, reason: "refresh_failed" });
          continue;
        }
        accessToken = refreshed.access_token;
        const newExpiresAt = refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          : null;
        await supabase
          .from("garmin_tokens")
          .update({
            access_token: accessToken,
            refresh_token: refreshed.refresh_token ?? tokenRow.refresh_token,
            expires_at: newExpiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
      }

      // Fire dailies + sleeps + userMetrics. userMetrics is what carries VO2
      // Max (running) and LT pace/HR — both incremental-only from Garmin, so
      // without this the webhook drop recovery would miss them.
      //
      // Serialized with 300ms between requests so we never burst 3 simultaneous
      // calls at Garmin's app-wide 100/min rate limit. Combined with cron +
      // manual syncs, parallel bursts were hitting 429.
      const dailies = await requestBackfill("dailies", accessToken, startEpoch, endEpoch);
      await new Promise(r => setTimeout(r, 300));
      const sleeps = await requestBackfill("sleeps", accessToken, startEpoch, endEpoch);
      await new Promise(r => setTimeout(r, 300));
      const userMetrics = await requestBackfill("userMetrics", accessToken, startEpoch, endEpoch);

      // Cloudflare / WAF rate-limit interstitials come as 403/503; Garmin
      // backend outages surface as 502. Treat all of these as "bail out, next
      // cycle will retry" so we don't hammer a throttling/dead endpoint.
      const isThrottle = (s: number) => s === 429 || s === 403 || s === 502 || s === 503;
      if (isThrottle(dailies.status) || isThrottle(sleeps.status) || isThrottle(userMetrics.status)) {
        rateLimited++;
        results.push({ userId, ok: false, reason: `throttled dailies=${dailies.status} sleeps=${sleeps.status} userMetrics=${userMetrics.status}` });
        console.warn(`[garmin-reconcile] Throttled on user ${userId.slice(0, 8)} dailies=${dailies.status} sleeps=${sleeps.status} userMetrics=${userMetrics.status} — stopping run, next cron will resume`);
        if (dailies.body) console.warn(`[garmin-reconcile] dailies body[0..200]: ${dailies.body.slice(0, 200)}`);
        if (sleeps.body) console.warn(`[garmin-reconcile] sleeps body[0..200]: ${sleeps.body.slice(0, 200)}`);
        if (userMetrics.body) console.warn(`[garmin-reconcile] userMetrics body[0..200]: ${userMetrics.body.slice(0, 200)}`);
        break;
      }

      const ok = dailies.ok && sleeps.ok && userMetrics.ok;
      if (ok) {
        succeeded++;
        results.push({ userId, ok: true });
      } else {
        failed++;
        const reason = `dailies=${dailies.status} sleeps=${sleeps.status} userMetrics=${userMetrics.status}`;
        results.push({ userId, ok: false, reason });
        if (dailies.body) console.warn(`[garmin-reconcile] user ${userId.slice(0, 8)} dailies status=${dailies.status} body[0..200]: ${dailies.body.slice(0, 200)}`);
        if (sleeps.body) console.warn(`[garmin-reconcile] user ${userId.slice(0, 8)} sleeps status=${sleeps.status} body[0..200]: ${sleeps.body.slice(0, 200)}`);
        if (userMetrics.body) console.warn(`[garmin-reconcile] user ${userId.slice(0, 8)} userMetrics status=${userMetrics.status} body[0..200]: ${userMetrics.body.slice(0, 200)}`);
      }
    }

    const processed = succeeded + failed + rateLimited;
    console.log(`[garmin-reconcile] ${mode} done — ${processed}/${userIds.length} processed (ok=${succeeded} fail=${failed} rate=${rateLimited}) yesterday=${yesterdayStr}`);

    return jsonResponse({
      ok: true,
      mode,
      yesterday: yesterdayStr,
      stale: userIds.length,
      processed,
      succeeded,
      failed,
      rateLimited,
      results,
    });

  } catch (e) {
    console.error("[garmin-reconcile] Unexpected error:", e);
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }
});
