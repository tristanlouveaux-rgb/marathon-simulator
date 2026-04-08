/**
 * sync-today-steps — intra-day activity from Garmin epoch summaries.
 *
 * Garmin's /wellness-api/rest/epochs returns 15-minute activity windows.
 * Each epoch has steps, activeKilocalories, and intensity classification.
 * We sum across all today's epochs and upsert into daily_metrics.
 *
 * Called by the client on app launch and on each foreground resume so the
 * strain ring stays current throughout the day.
 *
 * POST body: {} (no params — always fetches today)
 * Returns: { ok, steps, activeCalories, activeMinutes, highlyActiveMinutes, epochCount }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GARMIN_API_BASE = "https://apis.garmin.com";
const DAY_SEC = 86400;

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

interface GarminEpoch {
  steps?: number | null;
  activeKilocalories?: number | null;
  distanceInMeters?: number | null;
  /** "SEDENTARY" | "ACTIVE" | "HIGHLY_ACTIVE" — Garmin's intensity classification per 15-min window */
  intensity?: string | null;
  /** Alternative field name used in some Garmin API versions */
  intensityType?: string | null;
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

    // --- Auth ---
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const userId = user.id;

    // --- Garmin access token ---
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("garmin_tokens")
      .select("access_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (tokenErr || !tokenRow?.access_token) {
      return jsonResponse({ ok: false, error: "no_access_token" }, 400);
    }
    const accessToken: string = tokenRow.access_token;

    // --- Today's epoch window ---
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const midnight = new Date(todayStr + "T00:00:00Z");
    const startEpoch = Math.floor(midnight.getTime() / 1000);
    const endEpoch = Math.min(Math.floor(now.getTime() / 1000) + 900, startEpoch + DAY_SEC);

    // --- Fetch epochs (Garmin enforces 86400s max window; today is always < 24h) ---
    const url = `${GARMIN_API_BASE}/wellness-api/rest/epochs?uploadStartTimeInSeconds=${startEpoch}&uploadEndTimeInSeconds=${endEpoch}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[sync-today-steps] Garmin epochs ${res.status}: ${text}`);
      return jsonResponse({ ok: false, error: `garmin_${res.status}` }, 502);
    }

    const raw = await res.json();
    const epochs: GarminEpoch[] = Array.isArray(raw) ? raw : (raw.epochs ?? []);

    // Log first epoch to see available fields on first run
    if (epochs.length > 0) {
      console.log(`[sync-today-steps] Sample epoch keys: ${Object.keys(epochs[0]).join(', ')}`);
    }

    // Sum across all 15-min windows
    let steps = 0;
    let activeCalories = 0;
    let activeMinutes = 0;
    let highlyActiveMinutes = 0;

    for (const e of epochs) {
      steps += e.steps ?? 0;
      activeCalories += e.activeKilocalories ?? 0;

      const intensity = (e.intensity ?? e.intensityType ?? '').toUpperCase();
      if (intensity === 'HIGHLY_ACTIVE') {
        highlyActiveMinutes += 15;
        activeMinutes += 15;
      } else if (intensity === 'ACTIVE') {
        activeMinutes += 15;
      }
    }

    activeCalories = Math.round(activeCalories);
    const epochCount = epochs.length;

    console.log(`[sync-today-steps] ${todayStr}: ${steps} steps, ${activeCalories} kcal, ${activeMinutes}min active (${highlyActiveMinutes}min highly) from ${epochCount} epochs for user ${userId.slice(0, 8)}`);

    // --- Update step columns only (don't overwrite HRV/RHR from webhook) ---
    // Try update first; if no row exists yet, insert with step fields only.
    const stepPatch = {
      steps,
      active_calories: activeCalories,
      active_minutes: activeMinutes,
      highly_active_minutes: highlyActiveMinutes,
    };

    const { data: updated, error: updateErr } = await supabase
      .from("daily_metrics")
      .update(stepPatch)
      .eq("user_id", userId)
      .eq("day_date", todayStr)
      .select("day_date");

    if (updateErr) {
      console.error("[sync-today-steps] update error:", updateErr);
    } else if (!updated || updated.length === 0) {
      // No existing row — insert one (safe, won't overwrite anything)
      const { error: insertErr } = await supabase
        .from("daily_metrics")
        .insert({ user_id: userId, day_date: todayStr, ...stepPatch });
      if (insertErr) {
        console.error("[sync-today-steps] insert error:", insertErr);
      }
    }

    return jsonResponse({ ok: true, steps, activeCalories, activeMinutes, highlyActiveMinutes, epochCount });

  } catch (e) {
    console.error("[sync-today-steps] Unexpected error:", e);
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }
});
