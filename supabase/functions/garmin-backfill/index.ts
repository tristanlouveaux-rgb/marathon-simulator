/**
 * Garmin Historic Backfill edge function.
 *
 * Pulls N weeks of historic dailies + sleep from Garmin Health API
 * and upserts into daily_metrics + sleep_summaries.
 *
 * Garmin limits uploadStartTimeInSeconds/uploadEndTimeInSeconds to a max
 * window of 86400 seconds (1 day), so we paginate day-by-day.
 *
 * POST body: { weeks?: number }  (default 4, max 8)
 * Returns: { ok: true, days: number, sleepDays: number }
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

function toDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

interface GarminDaily {
  calendarDate?: string;
  startTimeInSeconds?: number;
  restingHeartRateInBeatsPerMinute?: number | null;
  maxHeartRateInBeatsPerMinute?: number | null;
  averageStressLevel?: number | null;
  vo2Max?: number | null;
  hrvSummary?: { lastNightAvg?: number | null } | null;
}

interface GarminSleep {
  calendarDate?: string;
  overallSleepScore?: { value?: number | null } | null;
  sleepScores?: { overall?: { value?: number | null } } | null;
  durationInSeconds?: number | null;
  deepSleepDurationInSeconds?: number | null;
  remSleepDurationInSeconds?: number | null;
  awakeDurationInSeconds?: number | null;
}

interface GarminHrv {
  calendarDate?: string;
  lastNight?: number | null;
}

async function garminGet(path: string, accessToken: string): Promise<any> {
  const res = await fetch(`${GARMIN_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Garmin API ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Fetch a Garmin endpoint for every day in [startEpoch, endEpoch).
 * Garmin enforces a max window of 86400s per request.
 * Returns all rows collected across all day-windows.
 */
async function fetchPaginated(
  endpoint: string,
  rowsKey: string,
  accessToken: string,
  startEpoch: number,
  endEpoch: number,
): Promise<any[]> {
  const all: any[] = [];
  for (let s = startEpoch; s < endEpoch; s += DAY_SEC) {
    const e = s + DAY_SEC;
    try {
      const data = await garminGet(
        `${endpoint}?uploadStartTimeInSeconds=${s}&uploadEndTimeInSeconds=${e}`,
        accessToken,
      );
      const rows: any[] = Array.isArray(data) ? data : (data[rowsKey] ?? []);
      all.push(...rows);
    } catch (err) {
      console.error(`[garmin-backfill] ${endpoint} day ${new Date(s * 1000).toISOString().split("T")[0]} error:`, String(err));
    }
  }
  return all;
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
    // Default 4 weeks (28 days) — enough for the 28-day physiology baseline.
    // Cap at 8 weeks to stay within edge function timeout (~150 API calls max).
    let weeks = 4;
    try {
      const body = await req.json();
      if (typeof body.weeks === "number" && body.weeks > 0) weeks = Math.min(body.weeks, 8);
    } catch (_) { /* default */ }

    // --- 3. Garmin access token ---
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("garmin_tokens")
      .select("access_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (tokenErr || !tokenRow?.access_token) {
      console.error("[garmin-backfill] No access token for user:", userId);
      return jsonResponse({ ok: false, error: "no_access_token" }, 400);
    }
    const accessToken: string = tokenRow.access_token;

    // --- 4. Date range ---
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - weeks * 7);
    const startEpoch = Math.floor(startDate.getTime() / 1000);
    const endEpoch = Math.floor(endDate.getTime() / 1000);
    const totalDays = Math.ceil((endEpoch - startEpoch) / DAY_SEC);

    console.log(`[garmin-backfill] ${weeks}w (${toDate(startDate)} → ${toDate(endDate)}, ${totalDays} day-windows) for user ${userId.slice(0, 8)}`);

    // --- 5-7. Fetch dailies, sleep, HRV in parallel (each paginates day-by-day internally) ---
    // Running all three simultaneously cuts wall-clock time by ~3×.
    const [dailyRows, sleepRows, hrvRows] = await Promise.all([
      fetchPaginated("/wellness-api/rest/dailies", "dailies", accessToken, startEpoch, endEpoch) as Promise<GarminDaily[]>,
      fetchPaginated("/wellness-api/rest/sleeps", "sleeps", accessToken, startEpoch, endEpoch) as Promise<GarminSleep[]>,
      fetchPaginated("/wellness-api/rest/hrv", "hrvSummaries", accessToken, startEpoch, endEpoch) as Promise<GarminHrv[]>,
    ]);

    console.log(`[garmin-backfill] Got ${dailyRows.length} daily, ${sleepRows.length} sleep, ${hrvRows.length} HRV rows`);
    if (dailyRows.length > 0) {
      const s = dailyRows[0];
      console.log(`[garmin-backfill] Daily sample: date=${s.calendarDate} rhr=${s.restingHeartRateInBeatsPerMinute} hrv=${JSON.stringify(s.hrvSummary)} stress=${s.averageStressLevel}`);
    }
    if (sleepRows.length > 0) {
      const s = sleepRows[0];
      console.log(`[garmin-backfill] Sleep sample: date=${s.calendarDate} score=${JSON.stringify(s.overallSleepScore ?? s.sleepScores)}`);
    }
    const hrvByDate: Record<string, number> = {};
    for (const e of hrvRows) {
      if (e.calendarDate && e.lastNight != null) hrvByDate[e.calendarDate] = e.lastNight;
    }
    console.log(`[garmin-backfill] HRV data for ${Object.keys(hrvByDate).length} days`);

    // --- 8. Upsert daily_metrics ---
    let upsertedDays = 0;
    for (const d of dailyRows) {
      const dayDate = d.calendarDate
        ?? (d.startTimeInSeconds ? toDate(new Date(d.startTimeInSeconds * 1000)) : null);
      if (!dayDate) continue;

      // Only include hrv_rmssd if we actually have a value — avoid overwriting
      // HRV data that was stored separately by the handleHrv webhook handler.
      const hrvVal = d.hrvSummary?.lastNightAvg ?? hrvByDate[dayDate] ?? undefined;
      const row: Record<string, unknown> = {
        user_id: userId,
        day_date: dayDate,
        resting_hr: d.restingHeartRateInBeatsPerMinute ?? null,
        max_hr: d.maxHeartRateInBeatsPerMinute ?? null,
        stress_avg: d.averageStressLevel ?? null,
        vo2max: d.vo2Max ?? null,
      };
      if (hrvVal != null) row.hrv_rmssd = hrvVal;

      const { error } = await supabase.from("daily_metrics").upsert(
        row,
        { onConflict: "user_id,day_date" },
      );
      if (error) console.error(`[garmin-backfill] daily_metrics upsert error ${dayDate}:`, error);
      else upsertedDays++;
    }

    // --- 9. Upsert sleep_summaries ---
    let upsertedSleep = 0;
    for (const s of sleepRows) {
      const calendarDate = s.calendarDate ?? null;
      if (!calendarDate) continue;

      const { error } = await supabase.from("sleep_summaries").upsert(
        {
          user_id: userId,
          calendar_date: calendarDate,
          overall_sleep_score: s.overallSleepScore?.value ?? s.sleepScores?.overall?.value ?? null,
          duration_sec: s.durationInSeconds ?? null,
          deep_sec: s.deepSleepDurationInSeconds ?? null,
          rem_sec: s.remSleepDurationInSeconds ?? null,
          awake_sec: s.awakeDurationInSeconds ?? null,
        },
        { onConflict: "user_id,calendar_date" },
      );
      if (error) console.error(`[garmin-backfill] sleep upsert error ${calendarDate}:`, error);
      else upsertedSleep++;
    }

    console.log(`[garmin-backfill] Done — ${upsertedDays} daily rows, ${upsertedSleep} sleep rows for user ${userId.slice(0, 8)}`);
    return jsonResponse({ ok: true, days: upsertedDays, sleepDays: upsertedSleep });

  } catch (e) {
    console.error("[garmin-backfill] Unexpected error:", e);
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }
});
