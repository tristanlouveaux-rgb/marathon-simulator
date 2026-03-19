/**
 * Garmin OAuth2 token refresh edge function.
 *
 * Accepts POST with user JWT → looks up refresh_token in garmin_tokens →
 * calls Garmin token endpoint with grant_type=refresh_token → updates DB.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GARMIN_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const garminClientId = Deno.env.get("GARMIN_CLIENT_ID")!;
    const garminClientSecret =
      Deno.env.get("GARMIN_CLIENT_SECRET") ??
      Deno.env.get("Garmin_client_secret");

    const supabase = createClient(supabaseUrl, serviceKey);

    // --- 1. Extract user_id from JWT ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");

    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);

    if (authErr || !user) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // --- 2. Look up current refresh_token ---
    const { data: tokenRow, error: selErr } = await supabase
      .from("garmin_tokens")
      .select("refresh_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (selErr || !tokenRow?.refresh_token) {
      console.error("[garmin-refresh-token] No refresh token found for user:", userId);
      return new Response(JSON.stringify({ ok: false, error: "no_refresh_token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- 3. Call Garmin token endpoint ---
    const tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: garminClientId,
      refresh_token: tokenRow.refresh_token,
    });

    if (garminClientSecret) {
      tokenBody.set("client_secret", garminClientSecret);
    }

    const tokenRes = await fetch(GARMIN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("[garmin-refresh-token] Token refresh failed:", tokenRes.status, text);
      return new Response(JSON.stringify({ ok: false, error: "refresh_failed", details: text }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tokenJson = await tokenRes.json();

    const accessToken: string = tokenJson.access_token;
    const refreshToken: string | null = tokenJson.refresh_token ?? null;
    const expiresIn: number | null = tokenJson.expires_in ?? null;

    if (!accessToken) {
      return new Response(
        JSON.stringify({ ok: false, error: "no_access_token_in_response" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // --- 4. Update garmin_tokens ---
    const { error: updateErr } = await supabase
      .from("garmin_tokens")
      .update({
        access_token: accessToken,
        refresh_token: refreshToken ?? tokenRow.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (updateErr) {
      console.error("[garmin-refresh-token] Failed to update tokens:", updateErr);
      return new Response(JSON.stringify({ ok: false, error: "update_failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[garmin-refresh-token] Tokens refreshed for user ${userId}, expires_at=${expiresAt}`);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[garmin-refresh-token] Unexpected error:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
