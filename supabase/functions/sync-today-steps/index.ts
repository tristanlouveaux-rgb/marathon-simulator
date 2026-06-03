/**
 * sync-today-steps — read today's step count from daily_metrics.
 *
 * Steps are written to daily_metrics by the Garmin webhook (handleDailies).
 * This function simply reads that row and returns it to the client so the
 * strain view can display steps without a separate Garmin API call (which
 * was failing with "App not Approved" on outbound requests).
 *
 * Called by the client on app launch and on each foreground resume.
 *
 * POST body: {} (no params — always fetches today)
 * Returns: { ok, steps, activeCalories, activeMinutes, highlyActiveMinutes }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Exact-match production origins + any localhost port for local dev.
const ALLOWED_ORIGINS = ["capacitor://localhost", "https://mosaicrunning.run"];
function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    // User-scoped client: JWT is verified AND row-level security applies to the
    // read below, so a missing filter can't leak another user's rows.
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // --- Auth ---
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    const userId = user.id;

    // --- Read today's row from daily_metrics (written by garmin-webhook) ---
    const todayStr = new Date().toISOString().split("T")[0];

    const { data: row, error: readErr } = await supabase
      .from("daily_metrics")
      .select("steps, active_calories, active_minutes, highly_active_minutes")
      .eq("user_id", userId)
      .eq("day_date", todayStr)
      .maybeSingle();

    if (readErr) {
      console.error("[sync-today-steps] DB read error:", readErr);
      return jsonResponse({ ok: false, error: "db_error" }, 500);
    }

    const steps = row?.steps ?? 0;
    const activeCalories = row?.active_calories ?? 0;
    const activeMinutes = row?.active_minutes ?? 0;
    const highlyActiveMinutes = row?.highly_active_minutes ?? 0;

    console.log(`[sync-today-steps] ${todayStr}: ${steps} steps, ${activeCalories} kcal, ${activeMinutes}min active for user ${userId.slice(0, 8)}`);

    return jsonResponse({ ok: true, steps, activeCalories, activeMinutes, highlyActiveMinutes });

  } catch (e) {
    console.error("[sync-today-steps] Unexpected error:", e);
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }
});
