/**
 * sync-strava-activities
 * ======================
 * Three modes (set via body.mode):
 *
 * - standalone (default): Fetch Strava activities + HR streams, upsert into
 *   garmin_activities, return GarminActivityRow[] for matchAndAutoComplete().
 *
 * - history: Aggregate garmin_activities from the past N weeks (default 8)
 *   into HistorySummaryRow[] for the Training tab sparkline + Stats PMC chart.
 *   No Strava API call — uses what's already in the DB. (Phase C1)
 *
 * Strava is always the activity source when connected — regardless of whether
 * the user also has a Garmin wearable. The Garmin/Apple wearable is used
 * separately for biometrics (VO2max, LT, HRV, sleep) via sync-physiology-snapshot.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// iTRIMP calculation (inlined — no imports in Deno edge)
// ---------------------------------------------------------------------------

function calculateITrimp(
  hrSamples: number[],
  timeSamples: number[],
  restingHR: number,
  maxHR: number,
  sex?: "male" | "female",
): number {
  const beta = sex === "female" ? 1.67 : 1.92;
  const hrRange = maxHR - restingHR;
  if (hrRange <= 0) return 0;
  let trimp = 0;
  for (let i = 1; i < hrSamples.length; i++) {
    const hr = hrSamples[i];
    if (hr <= restingHR) continue;
    const dt = timeSamples[i] - timeSamples[i - 1];
    if (dt <= 0) continue;
    const hrr = (hr - restingHR) / hrRange;
    trimp += dt * hrr * Math.exp(beta * hrr);
  }
  return trimp;
}

function calculateITrimpFromSummary(
  avgHR: number,
  durationSec: number,
  restingHR: number,
  maxHR: number,
  sex?: "male" | "female",
): number {
  const beta = sex === "female" ? 1.67 : 1.92;
  const hrRange = maxHR - restingHR;
  if (hrRange <= 0 || avgHR <= restingHR) return 0;
  const hrr = (avgHR - restingHR) / hrRange;
  return durationSec * hrr * Math.exp(beta * hrr);
}

// ---------------------------------------------------------------------------
// HR zone computation (% of MaxHR — matches Garmin's default scheme)
// ---------------------------------------------------------------------------

interface HRZones { z1: number; z2: number; z3: number; z4: number; z5: number; }

function calculateHRZones(
  hrSamples: number[],
  timeSamples: number[],
  maxHR: number,
): HRZones {
  const zones: HRZones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  if (maxHR <= 0 || hrSamples.length < 2) return zones;
  for (let i = 1; i < hrSamples.length; i++) {
    const dt = timeSamples[i] - timeSamples[i - 1];
    if (dt <= 0) continue;
    const pct = hrSamples[i] / maxHR;
    if      (pct < 0.60) zones.z1 += dt;
    else if (pct < 0.70) zones.z2 += dt;
    else if (pct < 0.80) zones.z3 += dt;
    else if (pct < 0.90) zones.z4 += dt;
    else                  zones.z5 += dt;
  }
  return zones;
}

// ---------------------------------------------------------------------------
// Km splits (runs only — uses moving stream to exclude pauses)
// ---------------------------------------------------------------------------

function calculateKmSplits(
  distanceSamples: number[],
  timeSamples: number[],
  movingSamples?: boolean[],
): number[] {
  if (distanceSamples.length < 2) return [];
  const totalM = distanceSamples[distanceSamples.length - 1];
  if (totalM < 1000) return [];

  const movingTime: number[] = new Array(timeSamples.length).fill(0);
  for (let i = 1; i < timeSamples.length; i++) {
    const dt = timeSamples[i] - timeSamples[i - 1];
    const isMoving = !movingSamples || movingSamples[i - 1];
    movingTime[i] = movingTime[i - 1] + (isMoving ? dt : 0);
  }

  const splits: number[] = [];
  const numKm = Math.floor(totalM / 1000);

  for (let km = 1; km <= numKm; km++) {
    const targetM = km * 1000;
    const prevTargetM = (km - 1) * 1000;

    let hiIdx = 1;
    while (hiIdx < distanceSamples.length - 1 && distanceSamples[hiIdx] < targetM) hiIdx++;
    const loIdx = hiIdx - 1;

    const dDist = distanceSamples[hiIdx] - distanceSamples[loIdx];
    const mtAtTarget = dDist > 0
      ? movingTime[loIdx] + (targetM - distanceSamples[loIdx]) / dDist * (movingTime[hiIdx] - movingTime[loIdx])
      : movingTime[hiIdx];

    let mtAtPrev = 0;
    if (km > 1) {
      let prevIdx = loIdx;
      while (prevIdx > 0 && distanceSamples[prevIdx] > prevTargetM) prevIdx--;
      const hiPrev = Math.min(prevIdx + 1, distanceSamples.length - 1);
      const dDistPrev = distanceSamples[hiPrev] - distanceSamples[prevIdx];
      mtAtPrev = dDistPrev > 0
        ? movingTime[prevIdx] + (prevTargetM - distanceSamples[prevIdx]) / dDistPrev * (movingTime[hiPrev] - movingTime[prevIdx])
        : movingTime[hiPrev];
    }

    const paceSecKm = mtAtTarget - mtAtPrev;
    if (paceSecKm > 0) splits.push(Math.round(paceSecKm));
  }
  return splits;
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshStravaToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  refreshToken: string,
  stravaClientId: string,
  stravaClientSecret: string,
): Promise<string> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: stravaClientId,
      client_secret: stravaClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);
  const json = await res.json();
  const newAccessToken: string = json.access_token;
  await supabase.from("strava_tokens").update({
    access_token: newAccessToken,
    refresh_token: json.refresh_token ?? refreshToken,
    expires_at: json.expires_at ? new Date(json.expires_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);
  return newAccessToken;
}

// ---------------------------------------------------------------------------
// Strava API helper
// ---------------------------------------------------------------------------

async function stravaGet(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Strava API ${path} failed: ${res.status}`);
  return res.json();
}

// Map Strava activity type → Garmin-compatible activity_type string
// Strava has two fields: sport_type (specific, newer) and type (generic, older).
// We prefer sport_type as it gives HIIT, TrailRun, etc. rather than the catch-all "Workout".
function mapStravaType(stravaType: string): string {
  const t = stravaType.toLowerCase();
  if (t === "run" || t === "virtualrun" || t === "trailrun" || t === "treadmill") return "RUNNING";
  if (t === "ride" || t === "virtualride" || t === "ebikeride") return "CYCLING";
  if (t === "swim") return "SWIMMING";
  if (t === "walk" || t === "hike") return "WALKING";
  if (t === "weighttraining" || t === "crossfit") return "STRENGTH_TRAINING";
  if (t === "hiit") return "HIIT";
  if (t === "yoga") return "YOGA";
  if (t === "pilates") return "PILATES";
  if (t === "tennis" || t === "squash" || t === "badminton") return "TENNIS";
  if (t === "soccer" || t === "football") return "SOCCER";
  if (t === "rugby") return "RUGBY";
  if (t === "rowing" || t === "indoorrowing") return "ROWING";
  if (t === "boxing" || t === "kickboxing") return "BOXING";
  if (t === "elliptical" || t === "stairstepper") return "INDOOR_CARDIO";
  // "Workout" is Strava's old catch-all type — map to generic cardio
  if (t === "workout") return "CARDIO";
  return stravaType.toUpperCase();
}

// ---------------------------------------------------------------------------
// History aggregation helpers (Phase C1)
// ---------------------------------------------------------------------------

interface HistorySummaryRow {
  weekStart: string;       // ISO date of Monday  e.g. "2026-02-17"
  totalTSS: number;        // Running-equivalent TSS for the week
  runningKm: number;       // km from running activities only
  zoneBase: number;        // Estimated base (Z1+Z2) TSS
  zoneThreshold: number;   // Estimated threshold (Z3) TSS
  zoneIntensity: number;   // Estimated intensity (Z4+Z5) TSS
  sportBreakdown: { sport: string; durationMin: number; tss: number }[];
}

/** ISO date string of the Monday of the week containing `date` (UTC). */
function getMondayISO(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay(); // 0=Sun
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + daysToMonday);
  return d.toISOString().split("T")[0];
}

function isRunningActivity(actType: string): boolean {
  const t = actType.toUpperCase();
  return t === "RUNNING" || t.includes("RUN");
}

/** Simplified running-equivalent coefficient per activity type. Mirrors SPORTS_DB.runSpec. */
function getRunSpec(actType: string): number {
  const t = actType.toUpperCase();
  if (isRunningActivity(t)) return 1.0;
  if (t.includes("CYCLING") || t.includes("RIDE") || t.includes("CARDIO")) return 0.55;
  if (t.includes("SWIMMING") || t.includes("SWIM")) return 0.20;
  if (t.includes("WALKING") || t.includes("HIKING") || t.includes("WALK")) return 0.30;
  if (t.includes("STRENGTH") || t.includes("WEIGHT")) return 0.30;
  if (t.includes("SOCCER") || t.includes("FOOTBALL")) return 0.40;
  if (t.includes("RUGBY")) return 0.35;
  if (t.includes("ROWING")) return 0.35;
  if (t.includes("YOGA") || t.includes("PILATES")) return 0.10;
  if (t.includes("TENNIS") || t.includes("SQUASH")) return 0.45;
  if (t.includes("BOXING") || t.includes("HIIT")) return 0.30;
  return 0.40;
}

/** Normalise activity_type to a clean sport label for the breakdown. */
function getSportLabel(actType: string): string {
  const t = actType.toUpperCase();
  if (isRunningActivity(t)) return "running";
  if (t.includes("CYCLING") || t.includes("RIDE")) return "cycling";
  if (t.includes("SWIMMING") || t.includes("SWIM")) return "swimming";
  if (t.includes("WALKING") || t.includes("HIKING") || t.includes("WALK")) return "walking";
  if (t.includes("STRENGTH") || t.includes("WEIGHT")) return "strength";
  if (t.includes("SOCCER") || t.includes("FOOTBALL")) return "soccer";
  if (t.includes("RUGBY")) return "rugby";
  if (t.includes("ROWING")) return "rowing";
  if (t.includes("YOGA")) return "yoga";
  if (t.includes("TENNIS") || t.includes("SQUASH")) return "tennis";
  if (t.includes("BOXING") || t.includes("HIIT")) return "hiit";
  return "other";
}

/**
 * Estimate zone distribution from TSS/hr.
 * Uses LOAD_PROFILES fractions from the client-side spec:
 *   easy      → base 0.90 / threshold 0.09 / intensity 0.01  (TSS/hr < 70)
 *   threshold → base 0.25 / threshold 0.60 / intensity 0.15  (70–95)
 *   vo2       → base 0.15 / threshold 0.35 / intensity 0.50  (> 95)
 */
function estimateZoneProfile(
  tss: number,
  durationMin: number,
): { base: number; threshold: number; intensity: number } {
  const tssPerHour = durationMin > 0 ? tss * (60 / durationMin) : 55;
  if (tssPerHour < 70) return { base: 0.90, threshold: 0.09, intensity: 0.01 };
  if (tssPerHour < 95) return { base: 0.25, threshold: 0.60, intensity: 0.15 };
  return { base: 0.15, threshold: 0.35, intensity: 0.50 };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stravaClientId = Deno.env.get("STRAVA_CLIENT_ID")!;
    const stravaClientSecret = Deno.env.get("STRAVA_CLIENT_SECRET")!;

    // Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonError(401, { error: "missing_auth_header" });

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return jsonError(401, { error: "invalid_auth" });

    const body = await req.json().catch(() => ({}));
    const mode: "standalone" | "history" = body.mode === "history" ? "history" : "standalone";
    const afterTimestamp: number = body.after_timestamp ?? Math.floor(Date.now() / 1000) - 28 * 86400;
    const biologicalSex: "male" | "female" | undefined =
      body.biological_sex === "male" || body.biological_sex === "female" ? body.biological_sex : undefined;

    const supabase = createClient(supabaseUrl, serviceKey);

    // -----------------------------------------------------------------------
    // HISTORY mode — aggregate garmin_activities into weekly TSS summaries.
    // No Strava API call needed; early-returns before token loading.
    // -----------------------------------------------------------------------
    if (mode === "history") {
      const weeksBack: number = typeof body.weeks === "number" ? Math.min(body.weeks, 52) : 8;
      const historyStart = new Date();
      historyStart.setUTCDate(historyStart.getUTCDate() - weeksBack * 7);

      const { data: actRows, error: actErr } = await supabase
        .from("garmin_activities")
        .select("activity_type, start_time, duration_sec, distance_m, itrimp")
        .eq("user_id", user.id)
        .gte("start_time", historyStart.toISOString())
        .order("start_time", { ascending: true });

      if (actErr) return jsonError(500, { error: "db_error", details: actErr.message });

      const weekMap = new Map<string, HistorySummaryRow>();

      for (const row of actRows ?? []) {
        const weekStart = getMondayISO(new Date(row.start_time as string));
        if (!weekMap.has(weekStart)) {
          weekMap.set(weekStart, {
            weekStart, totalTSS: 0, runningKm: 0,
            zoneBase: 0, zoneThreshold: 0, zoneIntensity: 0, sportBreakdown: [],
          });
        }
        const week = weekMap.get(weekStart)!;
        const durationMin = ((row.duration_sec as number) ?? 0) / 60;
        const actType = (row.activity_type as string) ?? "";
        const isRun = isRunningActivity(actType);
        const rs = getRunSpec(actType);

        // TSS: iTRIMP-normalised when available, duration-based estimate otherwise
        const rawTSS = (row.itrimp != null && (row.itrimp as number) > 0)
          ? ((row.itrimp as number) * 100) / 15000
          : durationMin * 0.55;
        const equivTSS = isRun ? rawTSS : rawTSS * rs;

        week.totalTSS += equivTSS;
        if (isRun && row.distance_m) week.runningKm += (row.distance_m as number) / 1000;

        const zp = estimateZoneProfile(rawTSS, durationMin);
        week.zoneBase += equivTSS * zp.base;
        week.zoneThreshold += equivTSS * zp.threshold;
        week.zoneIntensity += equivTSS * zp.intensity;

        const sport = getSportLabel(actType);
        const existing = week.sportBreakdown.find((s) => s.sport === sport);
        if (existing) {
          existing.durationMin += durationMin;
          existing.tss += equivTSS;
        } else {
          week.sportBreakdown.push({ sport, durationMin, tss: equivTSS });
        }
      }

      const result: HistorySummaryRow[] = Array.from(weekMap.values())
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
        .map((w) => ({
          ...w,
          totalTSS: Math.round(w.totalTSS),
          runningKm: Math.round(w.runningKm * 10) / 10,
          zoneBase: Math.round(w.zoneBase),
          zoneThreshold: Math.round(w.zoneThreshold),
          zoneIntensity: Math.round(w.zoneIntensity),
          sportBreakdown: w.sportBreakdown.map((s) => ({
            ...s,
            durationMin: Math.round(s.durationMin),
            tss: Math.round(s.tss),
          })),
        }));

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load Strava tokens
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("strava_tokens")
      .select("access_token, refresh_token, expires_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (tokenErr || !tokenRow) return jsonError(400, { error: "strava_not_connected" });

    // Refresh token if expired (60s buffer)
    let accessToken: string = tokenRow.access_token;
    if (tokenRow.expires_at) {
      const expiresMs = new Date(tokenRow.expires_at).getTime();
      if (Date.now() >= expiresMs - 60_000 && tokenRow.refresh_token) {
        accessToken = await refreshStravaToken(
          supabase, user.id, tokenRow.refresh_token, stravaClientId, stravaClientSecret,
        );
      }
    }

    // Fetch Strava activities
    const activities = await stravaGet(
      `/athlete/activities?per_page=50&after=${afterTimestamp}`,
      accessToken,
    ) as Array<Record<string, unknown>>;

    if (!Array.isArray(activities) || activities.length === 0) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load physiology context for iTRIMP from daily_metrics (Garmin webhook writes here)
    const { data: physioRow } = await supabase
      .from("daily_metrics")
      .select("resting_hr, max_hr")
      .eq("user_id", user.id)
      .order("day_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const restingHR: number = physioRow?.resting_hr ?? 55;
    const maxHR: number = physioRow?.max_hr ?? 190;

    // Load cached HR zones + km splits from DB for all activities in this batch.
    // This avoids re-fetching Strava streams for activities already processed —
    // Strava rate-limits at 100 req/15 min, so fetching 50 streams every sync burns
    // the quota and causes later activities to silently lose zone data.
    const garminIds = activities.map((a) => `strava-${a.id as number}`);
    const { data: cachedRows } = await supabase
      .from("garmin_activities")
      .select("garmin_id, itrimp, hr_zones, km_splits")
      .eq("user_id", user.id)
      .in("garmin_id", garminIds);

    const cachedMap = new Map<string, { itrimp: number | null; hr_zones: HRZones | null; km_splits: number[] | null }>();
    for (const r of (cachedRows ?? [])) {
      cachedMap.set(r.garmin_id, {
        itrimp: r.itrimp ?? null,
        hr_zones: r.hr_zones ?? null,
        km_splits: r.km_splits ?? null,
      });
    }

    // Process each activity: use cached stream data when available; fetch fresh otherwise.
    const rows: Record<string, unknown>[] = [];

    for (const act of activities) {
      const stravaId = act.id as number;
      const garminId = `strava-${stravaId}`;
      const startTime = act.start_date as string;
      const durationSec = (act.elapsed_time as number) ?? 0;
      const distanceM = (act.distance as number | null) ?? null;
      const avgHR = (act["average_heartrate"] as number | null) ?? null;
      const maxHrVal = (act["max_heartrate"] as number | null) ?? null;
      // sport_type is Strava's newer, more specific field (e.g. "HIIT", "TrailRun").
      // Fall back to type (e.g. "Workout", "Run") for older activities / API versions.
      const stravaActivityType = (act.sport_type as string) || (act.type as string) || "";
      const activityType = mapStravaType(stravaActivityType);
      const calories = (act["calories"] as number | null) ?? null;
      const isRun = activityType === "RUNNING";
      const mapObj = act.map as Record<string, unknown> | null;
      const polyline = (mapObj?.summary_polyline as string | null) ?? null;

      let iTrimp: number | null = null;
      let hrZones: HRZones | null = null;
      let kmSplits: number[] = [];
      let avgPaceSecKm: number | null = null;
      let needsUpsert = false; // only write to DB when we have new stream data

      // Distance-based pace (Strava doesn't give avg pace directly)
      if (distanceM && distanceM > 0 && durationSec > 0) {
        avgPaceSecKm = Math.round((durationSec / distanceM) * 1000);
      }

      const cached = cachedMap.get(garminId);

      if (cached?.hr_zones) {
        // Already processed — return cached zones without touching the Strava API
        iTrimp = cached.itrimp;
        hrZones = cached.hr_zones;
        kmSplits = cached.km_splits ?? [];
      } else {
        // First time seeing this activity (or zones were missing) — fetch stream
        needsUpsert = true;
        try {
          const streamKeys = isRun ? "heartrate,time,distance,moving" : "heartrate,time";
          const streamData = await stravaGet(
            `/activities/${stravaId}/streams?keys=${streamKeys}&key_by_type=true`,
            accessToken,
          ) as Record<string, { data: number[] | boolean[] }>;

          const hrData = streamData?.heartrate?.data as number[] | undefined;
          const timeData = streamData?.time?.data as number[] | undefined;
          const distData = streamData?.distance?.data as number[] | undefined;
          const movingData = streamData?.moving?.data as boolean[] | undefined;

          if (hrData && timeData && hrData.length > 1 && hrData.length === timeData.length) {
            iTrimp = calculateITrimp(hrData, timeData, restingHR, maxHR, biologicalSex);
            hrZones = calculateHRZones(hrData, timeData, maxHR);
          } else if (avgHR && durationSec > 0) {
            iTrimp = calculateITrimpFromSummary(avgHR, durationSec, restingHR, maxHR, biologicalSex);
          }

          if (isRun && distData && timeData && distData.length === timeData.length) {
            kmSplits = calculateKmSplits(distData, timeData as number[], movingData as boolean[] | undefined);
          }
        } catch {
          if (avgHR && durationSec > 0) {
            iTrimp = calculateITrimpFromSummary(avgHR, durationSec, restingHR, maxHR, biologicalSex);
          }
        }
      }

      // Upsert into garmin_activities — only write when we fetched fresh stream data
      if (needsUpsert) {
        await supabase.from("garmin_activities").upsert(
          {
            user_id: user.id,
            garmin_id: garminId,
            source: "strava",
            activity_type: activityType,
            start_time: startTime,
            duration_sec: durationSec,
            distance_m: distanceM != null ? Math.round(distanceM) : null,
            avg_pace_sec_km: avgPaceSecKm,
            avg_hr: avgHR,
            max_hr: maxHrVal,
            calories,
            aerobic_effect: null,
            anaerobic_effect: null,
            itrimp: iTrimp != null && iTrimp > 0 ? iTrimp : null,
            hr_zones: hrZones,
            km_splits: kmSplits.length > 0 ? kmSplits : null,
          },
          { onConflict: "garmin_id" },
        );
      }

      rows.push({
        garmin_id: garminId,
        activity_type: activityType,
        start_time: startTime,
        duration_sec: durationSec,
        distance_m: distanceM != null ? Math.round(distanceM) : null,
        avg_pace_sec_km: avgPaceSecKm,
        avg_hr: avgHR,
        max_hr: maxHrVal,
        calories,
        aerobic_effect: null,
        anaerobic_effect: null,
        garmin_rpe: null,
        iTrimp: iTrimp != null && iTrimp > 0 ? iTrimp : null,
        hrZones: hrZones,
        kmSplits: kmSplits.length > 0 ? kmSplits : null,
        polyline,
      });
    }

    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonError(500, { error: String(e) });
  }
});
