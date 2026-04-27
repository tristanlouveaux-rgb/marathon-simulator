/**
 * Garmin Historic Backfill edge function.
 *
 * Asks Garmin to push historic health data through the standard webhook by
 * POSTing to the /wellness-api/rest/backfill/{type} endpoints. Garmin returns
 * 202 Accepted and later delivers the data to our garmin-webhook edge function,
 * which writes daily_metrics / sleep_summaries / physiology_snapshots.
 *
 * The alternative — pulling via GET /wellness-api/rest/{type} — requires a
 * Consumer Pull Token (CPT) per Garmin's PULL partner agreement. Without a
 * valid CPT every pull returns "InvalidPullTokenException", so we use the
 * webhook model throughout.
 *
 * POST body: { weeks?: number }  (default 4, max 8 — Garmin allows up to 90d)
 * Returns: { ok, refreshStatus, requests: { dailies, sleeps, userMetrics, hrv } }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GARMIN_API_BASE = "https://apis.garmin.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function toDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * POST a /backfill/{type} request. Garmin replies 202 on success and pushes the
 * data via webhook later. 409 means a backfill for this window is already
 * queued — treated as success for our purposes.
 */
async function requestBackfill(
  type: string,
  accessToken: string,
  startEpoch: number,
  endEpoch: number,
): Promise<{ status: number; ok: boolean; body?: string }> {
  const url = `${GARMIN_API_BASE}/wellness-api/rest/backfill/${type}`
    + `?summaryStartTimeInSeconds=${startEpoch}`
    + `&summaryEndTimeInSeconds=${endEpoch}`;
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

    // --- 1. Auth ---
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const userId = user.id;

    // --- 2. Params ---
    let weeks = 4;
    try {
      const body = await req.json();
      if (typeof body.weeks === "number" && body.weeks > 0) weeks = Math.min(body.weeks, 8);
    } catch (_) { /* default */ }

    // --- 3. Garmin access token (auto-refresh if expired or near expiry) ---
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("garmin_tokens")
      .select("access_token, refresh_token, expires_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (tokenErr || !tokenRow?.access_token) {
      console.error("[garmin-backfill] No access token for user:", userId);
      return jsonResponse({ ok: false, error: "no_access_token" }, 400);
    }

    let accessToken: string = tokenRow.access_token;
    const expiresAtMs = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : 0;
    const refreshBufferMs = 5 * 60 * 1000;
    const needsRefresh = !expiresAtMs || (expiresAtMs - Date.now() < refreshBufferMs);
    let refreshStatus: 'skipped-fresh' | 'refreshed' | 'failed' | 'no-refresh-token' = 'skipped-fresh';
    if (!needsRefresh) refreshStatus = 'skipped-fresh';
    else if (!tokenRow.refresh_token) refreshStatus = 'no-refresh-token';

    if (needsRefresh && tokenRow.refresh_token) {
      console.log(`[garmin-backfill] Access token near expiry (expires_at=${tokenRow.expires_at}) — refreshing`);
      try {
        const clientId = Deno.env.get("GARMIN_CLIENT_ID")!;
        const clientSecret = Deno.env.get("GARMIN_CLIENT_SECRET") ?? Deno.env.get("Garmin_client_secret");
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: tokenRow.refresh_token,
        });
        if (clientSecret) body.set("client_secret", clientSecret);
        const refreshRes = await fetch("https://diauth.garmin.com/di-oauth2-service/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        if (!refreshRes.ok) {
          const txt = await refreshRes.text();
          console.error(`[garmin-backfill] Token refresh failed ${refreshRes.status}: ${txt}`);
          refreshStatus = 'failed';
          return jsonResponse({ ok: false, error: "refresh_failed", refreshStatus, refreshHttpStatus: refreshRes.status, details: txt }, 400);
        }
        const rj = await refreshRes.json();
        accessToken = rj.access_token;
        const newExpiresAt = rj.expires_in
          ? new Date(Date.now() + rj.expires_in * 1000).toISOString()
          : null;
        await supabase
          .from("garmin_tokens")
          .update({
            access_token: accessToken,
            refresh_token: rj.refresh_token ?? tokenRow.refresh_token,
            expires_at: newExpiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
        refreshStatus = 'refreshed';
        console.log(`[garmin-backfill] Token refreshed — new expires_at=${newExpiresAt}`);
      } catch (e) {
        console.error("[garmin-backfill] Refresh error:", String(e));
        return jsonResponse({ ok: false, error: "refresh_exception", details: String(e) }, 500);
      }
    }

    // --- 4. Date range ---
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - weeks * 7);
    const startEpoch = Math.floor(startDate.getTime() / 1000);
    const endEpoch = Math.floor(endDate.getTime() / 1000);

    console.log(`[garmin-backfill] ${weeks}w (${toDate(startDate)} → ${toDate(endDate)}) for user ${userId.slice(0, 8)}`);

    // --- 5. Request webhook backfills for each data type ---
    // Garmin queues the request and pushes data to garmin-webhook over the
    // following minutes (usually within 5 min for recent ranges).
    //
    // Serialized with 300ms between requests so we never burst 4 simultaneous
    // calls at Garmin's app-wide 100/min rate limit. (Parallel was cheaper but
    // caused self-DOS when combined with cron + manual syncs in short windows.)
    const dailies = await requestBackfill("dailies", accessToken, startEpoch, endEpoch);
    await new Promise(r => setTimeout(r, 300));
    const sleeps = await requestBackfill("sleeps", accessToken, startEpoch, endEpoch);
    await new Promise(r => setTimeout(r, 300));
    const hrv = await requestBackfill("hrv", accessToken, startEpoch, endEpoch);
    await new Promise(r => setTimeout(r, 300));
    const userMetrics = await requestBackfill("userMetrics", accessToken, startEpoch, endEpoch);

    console.log(`[garmin-backfill] Requests: dailies=${dailies.status} sleeps=${sleeps.status} hrv=${hrv.status} userMetrics=${userMetrics.status}`);
    if (dailies.body) console.warn(`[garmin-backfill] dailies body: ${dailies.body}`);
    if (sleeps.body) console.warn(`[garmin-backfill] sleeps body: ${sleeps.body}`);
    if (hrv.body) console.warn(`[garmin-backfill] hrv body: ${hrv.body}`);
    if (userMetrics.body) console.warn(`[garmin-backfill] userMetrics body: ${userMetrics.body}`);

    const allOk = dailies.ok && sleeps.ok && hrv.ok && userMetrics.ok;
    // Detect rate-limit so the client can set a cooldown instead of re-queueing.
    // Garmin returns 429 natively; Cloudflare sometimes wraps it as 502/503.
    const isThrottle = (s: number) => s === 429 || s === 403 || s === 502 || s === 503;
    const rateLimited = [dailies, sleeps, hrv, userMetrics].some(r => isThrottle(r.status));
    console.log(`[garmin-backfill] Done — ${allOk ? 'all requests queued' : 'partial failure'} (refresh=${refreshStatus}, rateLimited=${rateLimited})`);

    return jsonResponse({
      ok: allOk,
      rateLimited,
      refreshStatus,
      expiresAtBefore: tokenRow.expires_at,
      requests: {
        dailies: dailies.status,
        sleeps: sleeps.status,
        hrv: hrv.status,
        userMetrics: userMetrics.status,
      },
      errorBodies: {
        dailies: dailies.body,
        sleeps: sleeps.body,
        hrv: hrv.body,
        userMetrics: userMetrics.body,
      },
    });

  } catch (e) {
    console.error("[garmin-backfill] Unexpected error:", e);
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }
});
